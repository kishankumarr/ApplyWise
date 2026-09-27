"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useMutation } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  toast,
} from "@applywise/ui";
import { api, downloadFile, errorMessage } from "@/lib/api";

export function AccountSettings() {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const del = useMutation({
    mutationFn: () => api("/api/account/delete", { body: { confirmText } }),
    onSuccess: async () => {
      toast.success("Your account and data were deleted.");
      await signOut({ callbackUrl: "/?deleted=1" });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Export your data</CardTitle>
          <CardDescription>Download everything we hold about you as JSON (profile, facts, resume text, drafts, applications, audit log).</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => downloadFile("/api/account/export", "GET").catch((e) => toast.error(errorMessage(e)))}>
            <Download /> Export my data
          </Button>
        </CardContent>
      </Card>
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Delete account</CardTitle>
          <CardDescription>Permanently deletes your account, uploaded files, profile, drafts, applications and imported jobs. This cannot be undone.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => { setConfirmText(""); setOpen(true); }}>
            <Trash2 /> Delete my account
          </Button>
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>All personal data is removed immediately. Consider exporting your data first.</DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertDescription>This permanently deletes your data.</AlertDescription>
          </Alert>
          <div className="space-y-1">
            <Label htmlFor="confirm-delete">Type DELETE to confirm</Label>
            <Input id="confirm-delete" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => del.mutate()} disabled={confirmText !== "DELETE" || del.isPending}>
              Permanently delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
