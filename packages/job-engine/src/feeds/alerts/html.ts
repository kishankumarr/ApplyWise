/**
 * Minimal, forgiving HTML reader for job-alert emails: a tokenizer that builds a light element
 * tree, plus helpers that read the visible text line by line. No DOM library, never throws on
 * malformed markup, and never resolves or fetches anything (links and images stay inert strings).
 */

export interface HtmlElement {
  name: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlElement | null;
}

/** Text nodes are plain (already entity-decoded) strings. */
export type HtmlNode = HtmlElement | string;

const TAG_NAME = /[a-zA-Z][\w:-]*/y;
/** An attribute value quote left open for longer than this ends at the next ">" instead. */
const MAX_QUOTED = 8192;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements whose content is never visible text; skipped by the tokenizer. */
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp", "template"]);
/** Opening one of these closes an open <p> (simplified HTML rule). */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
/** Deeper nesting is flattened so recursive walks stay shallow on hostile input. */
const MAX_DEPTH = 256;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", ndash: "–", mdash: "—",
  hellip: "…", bull: "•", middot: "·", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  rarr: "→", larr: "←", copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×",
  plusmn: "±", star: "☆", starf: "★", check: "✓", verbar: "|", vert: "|", colon: ":", sol: "/", lpar: "(", rpar: ")",
  comma: ",", period: ".", excl: "!", quest: "?", num: "#", percnt: "%", dollar: "$", equals: "=", plus: "+", hyphen: "-",
  dash: "-", eacute: "é", egrave: "è", aacute: "á", agrave: "à", iacute: "í", oacute: "ó", uacute: "ú", auml: "ä", ouml: "ö",
  uuml: "ü", ccedil: "ç", ntilde: "ñ", szlig: "ß", shy: "", zwj: "", zwnj: "", lrm: "", rlm: "", ZeroWidthSpace: "",
};

/** Decode HTML entities once ("&amp;lt;" -> "&lt;"). Unknown entities are left as they are. */
export function decodeHtmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? match;
  });
}

function parseAttrs(src: string): Record<string, string> {
  // No prototype: attribute names such as "constructor" or "__proto__" stay plain keys.
  const attrs = Object.create(null) as Record<string, string>;
  if (!src) return attrs;
  for (const m of src.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/**
 * Linear scanner over `html`: every search moves forward and repeated lookups ("next >", "next
 * quote") are cached, so hostile input (unclosed quotes, thousands of stray "<") stays O(n).
 */
function scanner(html: string) {
  const cache = new Map<string, { from: number; at: number }>();
  /** First index of `s` at or after `from` (-1 when none). */
  const next = (s: string, from: number): number => {
    const c = cache.get(s);
    if (c && c.from <= from && (c.at === -1 || c.at >= from)) return c.at;
    const at = html.indexOf(s, from);
    cache.set(s, { from, at });
    return at;
  };
  /** Index of the ">" closing the tag that starts at `from`; quoted values may contain ">". */
  const tagEnd = (from: number): number => {
    let last = 0;
    for (let i = from; i < html.length; i++) {
      const ch = html.charCodeAt(i);
      if (ch === 62) return i; // >
      if ((ch === 34 || ch === 39) && last === 61) {
        // value quote right after "=": jump to its closing quote
        const close = next(ch === 34 ? '"' : "'", i + 1);
        if (close < 0 || close - i > MAX_QUOTED) return next(">", from);
        i = close;
        last = ch;
        continue;
      }
      if (ch > 32) last = ch;
    }
    return -1;
  };
  return { next, tagEnd };
}

/** Parse HTML into a tree rooted at a synthetic "#root" element. */
export function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { name: "#root", attrs: {}, children: [], parent: null };
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  const { next, tagEnd } = scanner(html);
  let text = 0; // start of pending text
  const flushText = (end: number) => {
    if (end > text) top().children.push(decodeHtmlEntities(html.slice(text, end)));
  };
  let pos = 0;
  while (pos < html.length) {
    const lt = next("<", pos);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      // Comments, including Outlook conditional comments.
      flushText(lt);
      const end = next("-->", lt + 4);
      pos = text = end < 0 ? html.length : end + 3;
      continue;
    }
    const c1 = html.charCodeAt(lt + 1);
    if (c1 === 33 || c1 === 63) {
      // <!DOCTYPE>, <![endif]>, <?xml ?>
      flushText(lt);
      const end = next(">", lt + 2);
      pos = text = end < 0 ? html.length : end + 1;
      continue;
    }
    const closing = c1 === 47; // "/"
    TAG_NAME.lastIndex = closing ? lt + 2 : lt + 1;
    const tagName = TAG_NAME.exec(html)?.[0];
    if (!tagName) {
      pos = lt + 1; // a literal "<" in text
      continue;
    }
    const end = tagEnd(TAG_NAME.lastIndex);
    if (end < 0) break; // no ">" left: the rest is text
    flushText(lt);
    pos = text = end + 1;
    const name = tagName.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrSrc = html.slice(TAG_NAME.lastIndex, end);
    if (RAW_TEXT.has(name)) {
      // Content is never visible: skip to the matching end tag.
      const close = new RegExp(`</${name}\\s*>`, "ig");
      close.lastIndex = pos;
      pos = text = close.exec(html) ? close.lastIndex : html.length;
      continue;
    }
    // A few implied end tags, enough for sloppy email markup.
    const cur = top().name;
    if (cur === "p" && CLOSES_P.has(name)) stack.pop();
    else if (name === "li" && cur === "li") stack.pop();
    else if ((name === "td" || name === "th") && (cur === "td" || cur === "th")) stack.pop();
    else if (name === "tr") {
      if (top().name === "td" || top().name === "th") stack.pop();
      if (top().name === "tr") stack.pop();
    }
    const parent = top();
    const el: HtmlElement = { name, attrs: parseAttrs(attrSrc), children: [], parent };
    parent.children.push(el);
    if (!VOID.has(name) && !attrSrc.trimEnd().endsWith("/") && stack.length < MAX_DEPTH) stack.push(el);
  }
  flushText(html.length);
  return root;
}

// ---------------------------------------------------------------- visible text

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "center", "dd", "div", "dl", "dt", "fieldset", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "ul",
]);
const NEVER_VISIBLE = new Set(["head", "script", "style", "title", "template", "select", "noscript", "svg", "object"]);

/** Hidden preheaders and mobile/desktop duplicates: display:none, max-height:0, text-indent:-9999px, ... */
export function isHiddenElement(el: HtmlElement): boolean {
  if ("hidden" in el.attrs) return true;
  const style = el.attrs.style;
  if (!style) return false;
  const s = `;${style.toLowerCase().replace(/\s+/g, "")};`;
  if (/;(display:none|visibility:hidden|mso-hide:all)[;!]/.test(s)) return true;
  if (/;(max-height:0(px)?|opacity:0)[;!]/.test(s)) return true;
  if (/;text-indent:-\d{3,}/.test(s)) return true;
  // font-size:0 alone is the usual whitespace trick around inline-block badges; hidden only with more signals.
  return /;font-size:0(px)?[;!]/.test(s) && /;(line-height|height|max-height):0(px)?[;!]/.test(s);
}

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad\u180e]|\u034f/g;

/** Collapse whitespace and drop zero-width characters. */
export function tidyText(value: string): string {
  return value.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}

/** Links and buttons render as separate words even without whitespace ("Quokka<a>Learn more</a>"). */
const WORD_BREAK = new Set(["a", "button"]);

/**
 * Visible text of an element, one entry per block-level line. `maxChars` stops the walk early, so
 * reading a small part of a huge (or deeply nested) element stays cheap.
 */
export function visibleLines(node: HtmlElement, maxChars = Infinity): string[] {
  const out: string[] = [];
  let cur = "";
  let budget = maxChars;
  const flush = () => {
    const t = tidyText(cur);
    if (t) out.push(t);
    cur = "";
  };
  const walk = (n: HtmlNode) => {
    if (budget <= 0) return;
    if (typeof n === "string") {
      cur += n.length > budget ? n.slice(0, budget) : n;
      budget -= n.length;
      return;
    }
    if (NEVER_VISIBLE.has(n.name) || isHiddenElement(n)) return;
    budget--; // elements count too, so a huge empty subtree is not walked in full
    const block = BLOCK.has(n.name);
    if (block) flush();
    else if (WORD_BREAK.has(n.name)) cur += " ";
    for (const c of n.children) {
      if (budget <= 0) break;
      walk(c);
    }
    if (block) flush();
    else if (WORD_BREAK.has(n.name)) cur += " ";
  };
  walk(node);
  flush();
  return out;
}

/** Visible (non-whitespace-collapsed) text length of an element, memoised per element. */
export function visibleLength(node: HtmlElement, memo: Map<HtmlElement, number>): number {
  const known = memo.get(node);
  if (known !== undefined) return known;
  let total = 0;
  if (!NEVER_VISIBLE.has(node.name) && !isHiddenElement(node)) {
    for (const c of node.children) total += typeof c === "string" ? c.trim().length : visibleLength(c, memo);
  }
  memo.set(node, total);
  return total;
}

/** Every visible element matching `test`, in document order. */
export function findElements(node: HtmlElement, test: (el: HtmlElement) => boolean): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (el: HtmlElement) => {
    for (const c of el.children) {
      if (typeof c === "string" || NEVER_VISIBLE.has(c.name) || isHiddenElement(c)) continue;
      if (test(c)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** First descendant matching `test` (depth-first), or null; gives up after `maxNodes` elements. */
export function findElement(node: HtmlElement, test: (el: HtmlElement) => boolean, maxNodes = Infinity): HtmlElement | null {
  let left = maxNodes;
  const find = (el: HtmlElement): HtmlElement | null => {
    for (const c of el.children) {
      if (typeof c === "string") continue;
      if (--left < 0) return null;
      if (test(c)) return c;
      const hit = find(c);
      if (hit || left < 0) return hit;
    }
    return null;
  };
  return find(node);
}
