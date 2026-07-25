// Attach from Google Drive: opens on Recents, live-searches as you type.
// Enter inserts the file as a link chip in the body (Gmail's default);
// Ctrl+Enter attaches files ≤ 25 MB as a real copy. Gated on the account's
// Drive grant — without it, the single row is a Reconnect CTA.
import { useEffect, useRef, useState } from "react";
import { backend } from "@/lib/ipc";
import { activeCapabilities, useSettings } from "@/stores/settings";
import { driveChipHtml, useUi } from "@/stores/ui";
import type { DriveFile } from "@/lib/types";
import { Kbd } from "@/components/Kbd";
import { PickerShell, type PickerItem } from "./PickerShell";

const SEARCH_DEBOUNCE_MS = 250;
const INLINE_LIMIT = 25_000_000;

function glyph(mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "📊";
  if (mime.includes("presentation")) return "📽";
  if (mime.includes("folder")) return "📁";
  if (mime.includes("zip") || mime.includes("compressed")) return "🗜";
  return "📄";
}

function fmtSize(bytes: number | null): string {
  if (bytes === null) return "Google Doc";
  if (bytes > 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes > 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay)
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Insert the picked file as a link chip + remember it for share-on-send. */
function insertChip(file: DriveFile) {
  const ref = {
    fileId: file.id,
    name: file.name,
    url: file.webViewLink,
    size: file.size,
  };
  useUi.setState((s) => ({
    compose: s.compose
      ? { ...s.compose, driveLinks: [...s.compose.driveLinks, ref] }
      : null,
  }));
  window.dispatchEvent(
    new CustomEvent("fission:insert-html", { detail: { html: driveChipHtml(ref) } })
  );
}

async function attachAsCopy(file: DriveFile) {
  const ui = useUi.getState();
  // Same aggregate ceiling addFiles enforces — one 20 MB copy on top of an
  // 18 MB draft must divert to a link, not fail at send with a raw size error.
  const existing = (ui.compose?.attachments ?? []).reduce(
    (n, a) => n + a.dataBase64.length * 0.75,
    0
  );
  if (existing + (file.size ?? 0) > INLINE_LIMIT) {
    ui.showToast(
      "That would push attachments over the 25 MB limit — insert the link instead"
    );
    return;
  }
  try {
    const att = await backend.driveDownloadAttach(file.id);
    useUi.setState((s) => ({
      compose: s.compose
        ? { ...s.compose, attachments: [...s.compose.attachments, att] }
        : null,
    }));
  } catch (e) {
    ui.showToast(String(e));
  }
}

export function DrivePicker() {
  const [results, setResults] = useState<DriveFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const hasDrive = activeCapabilities().drive;
  const keyHints = useSettings((s) => s.settings.showKeyHints);

  const search = (query: string) => {
    const id = ++seq.current;
    backend
      .driveSearch(query)
      .then((files) => {
        if (seq.current !== id) return;
        setResults(files);
        setError(null);
      })
      .catch((e) => {
        if (seq.current !== id) return;
        setResults([]);
        setError(String(e));
      });
  };

  useEffect(() => {
    if (hasDrive) search(""); // Recents
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDrive]);

  const onQuery = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => search(q), SEARCH_DEBOUNCE_MS);
  };

  if (!hasDrive) {
    return (
      <PickerShell
        title="Attach from Google Drive"
        items={[
          {
            label: "Grant Google Drive access to attach from Drive",
            detail: "Settings → Account → Reconnect",
            run: () => {
              useUi.getState().setSettingsTab("account");
              useUi.getState().setScreen("settings");
            },
          },
        ]}
      />
    );
  }

  const items: PickerItem[] =
    results === null
      ? [{ label: "Loading Drive…", run: () => {} }]
      : error
        ? [
            {
              label: error,
              detail: "Settings → Account",
              run: () => {
                useUi.getState().setSettingsTab("account");
                useUi.getState().setScreen("settings");
              },
            },
          ]
        : results.map((f) => {
            const attachable =
              f.size !== null && f.size <= INLINE_LIMIT && f.webViewLink !== "";
            return {
              label: `${glyph(f.mimeType)} ${f.name}`,
              detail: [fmtSize(f.size), fmtWhen(f.modifiedTime)]
                .filter(Boolean)
                .join(" · "),
              run: () => insertChip(f),
              runAlt: attachable ? () => void attachAsCopy(f) : undefined,
            };
          });

  return (
    <PickerShell
      title="Attach from Google Drive"
      items={items}
      onQuery={onQuery}
      queryPlaceholder="Search Drive by name or content…"
      footer={
        // The whole strip is a key hint, so with hints off the footer goes
        // rather than leaving an empty bordered band.
        keyHints ? (
          <>
            <Kbd>↵</Kbd> insert link · <Kbd>Ctrl+↵</Kbd> attach copy (≤ 25 MB)
          </>
        ) : undefined
      }
    />
  );
}
