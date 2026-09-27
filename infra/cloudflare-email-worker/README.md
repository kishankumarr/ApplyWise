# ApplyWise inbound-email relay (Cloudflare Email Worker)

Gives each ApplyWise user a private forwarding address such as `jobs-7kq2...@in.example.com`. Users add
a Gmail (or Outlook, Zoho, iCloud) filter that forwards only their job-alert emails to it. ApplyWise
never holds mailbox credentials, and only the alerts the user picks ever leave their inbox.

```
sender -> Gmail filter "Forward it to" -> Cloudflare Email Routing (catch-all)
       -> this Worker -> POST https://<app>/api/inbound/email (signed) -> parsed, raw email discarded
```

The Worker stores nothing and logs nothing about the message. It has no dependencies.

## What you need

- A domain (or subdomain) whose DNS is on Cloudflare. It should not already receive other mail,
  because Email Routing takes over its MX records.
- A public HTTPS URL for ApplyWise. For a local install, expose it with Cloudflare Tunnel or use IMAP
  instead, which needs no public URL.
- Node.js, to run `npx wrangler`.

Cost: inbound Email Routing is free, and the Worker runs on the Workers free plan (100,000
requests/day). Signing a message takes well under the 10 ms CPU limit.

## Setup

1. **Turn on Email Routing.** In the Cloudflare dashboard, open your domain > **Email** > **Email
   Routing** > **Enable**. Add the MX and TXT (SPF) records it proposes.

2. **Create the shared secret.** It must be at least 24 characters:

   ```sh
   openssl rand -hex 32
   ```

3. **Deploy the Worker** from this folder:

   ```sh
   cp wrangler.toml.example wrangler.toml   # then set WEBHOOK_URL to https://<your-app>/api/inbound/email
   npx wrangler login
   npx wrangler secret put INBOUND_SECRET   # paste the secret from step 2
   npx wrangler deploy
   ```

4. **Route all addresses to the Worker.** Go to **Email Routing** > **Routing rules** > **Catch-all
   address** > **Edit**. Set the action to **Send to a Worker**, choose `applywise-email-relay`, then
   save and enable the rule. Use the catch-all rule, not one rule per user: Cloudflare allows only 200
   rules per domain.

5. **Configure ApplyWise** and restart it:

   ```sh
   INBOUND_EMAIL_DOMAIN=in.example.com      # the domain from step 1
   INBOUND_EMAIL_SECRET=<the secret from step 2>
   ```

6. **Test it.** In ApplyWise, open **Job sources** and create a forwarding address. Send an email to
   that address, then check that the source shows a new sync.

## Gmail forwarding

1. In Gmail, open **Settings** > **Forwarding and POP/IMAP** > **Add a forwarding address**, and paste
   the ApplyWise address.
2. Google sends a confirmation email to that address from `forwarding-noreply@google.com`. ApplyWise
   recognises it and shows the confirmation link and code under **Job sources**. Open the link
   yourself. The server never follows it.
3. Create a filter with **From:** set to the job-alert senders ApplyWise suggests, tick **Forward it
   to** and choose the ApplyWise address.

Do not turn on "Forward a copy of incoming mail". That forwards your whole inbox. Gmail forwards only
new mail, so older alerts need a manual forward or an .eml upload.

## Wire format

`POST WEBHOOK_URL`, with the raw RFC 822 message as the body and these headers:

| Header | Value |
| --- | --- |
| `content-type` | `message/rfc822` |
| `x-aw-envelope-to` | envelope recipient (identifies the user) |
| `x-aw-envelope-from` | envelope sender |
| `x-aw-timestamp` | unix seconds |
| `x-aw-signature` | hex HMAC-SHA256 of `"<timestamp>.<recipient, lowercased>."` + raw body, keyed with the shared secret |

ApplyWise checks the signature with `verifyInboundSignature` from `@applywise/mail-sources`, using a
constant-time comparison. It rejects timestamps more than 5 minutes from its own clock.

To test the webhook without Cloudflare, send a signed request yourself:

```sh
TS=$(date +%s)
SIG=$( (printf '%s.' "$TS"; cat alert.eml) | openssl dgst -sha256 -hmac "$INBOUND_EMAIL_SECRET" -hex | sed 's/^.* //')
curl -X POST "https://<your-app>/api/inbound/email" \
  -H "content-type: message/rfc822" \
  -H "x-aw-envelope-to: jobs-<token>@$INBOUND_EMAIL_DOMAIN" -H "x-aw-envelope-from: test@example.com" \
  -H "x-aw-timestamp: $TS" -H "x-aw-signature: $SIG" \
  --data-binary @alert.eml
```

## Behaviour and limits

- The Worker rejects messages larger than 5 MB. Cloudflare itself accepts up to 25 MiB.
- It rejects recipients that do not look like `jobs-<token>@...`. These are spam to the catch-all
  address, and rejecting them avoids a webhook call.
- ApplyWise responds with:
  - 200 for accepted mail and for unknown or paused addresses, so the relay does not retry them
  - 401 for a bad signature
  - 413 for a message that is too large
  - 5xx for a temporary failure
- `WEBHOOK_URL` must be `https://`. The Worker does not follow redirects, so a 3xx counts as a failure:
  point it at the final URL (no http-to-https or trailing-slash redirect).
- On any response other than 2xx, or on a timeout (20 s), the Worker throws. Cloudflare then does not
  accept the message, and the sending server retries or bounces it. Cloudflare does not document the
  exact SMTP reply.
- If ApplyWise is down for long, the sending server may give up and bounce. If you need durable
  delivery, put a Cloudflare Queue between the Worker and the webhook.

## Rotating the secret

1. Run `npx wrangler secret put INBOUND_SECRET` with a new value.
2. Update `INBOUND_EMAIL_SECRET` in ApplyWise and restart it.

Mail that arrives between the two steps is rejected with 401 and retried by the sending server.
