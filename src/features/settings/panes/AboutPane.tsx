import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { Pill } from "@/components/Pill";
import { RowGroup, SettingRow } from "@/components/SettingRow";
import { isTauri, openExternal } from "@/lib/ipc";
import { HELP_LINKS } from "@/lib/settings-search";
import { useUpdater } from "@/lib/updater";

export function AboutPane() {
  return (
    <>
      <AboutCard />
      <RowGroup title="Help">
        {HELP_LINKS.map((h) => (
          <SettingRow key={h.url} label={h.label} help={h.url.replace(/^https:\/\//, "")}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void openExternal(h.url)}
            >
              Open
            </Button>
          </SettingRow>
        ))}
      </RowGroup>
    </>
  );
}

function AboutCard() {
  const [version, setVersion] = useState<string | null>(null);
  const status = useUpdater((s) => s.status);
  const checking = useUpdater((s) => s.checking);
  const ready = useUpdater((s) => s.ready);
  const downloading = useUpdater((s) => s.downloading);
  const error = useUpdater((s) => s.error);

  useEffect(() => {
    if (!isTauri) return setVersion(null);
    void import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-4 px-4 py-4">
        <img
          src="/snail-mail-icon.svg"
          alt=""
          width={52}
          height={52}
          className="h-[52px] w-[52px] shrink-0"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-ink">
              Snail Mail {version ?? ""}
            </span>
            <Pill tone="neutral">{isTauri ? "stable channel" : "browser demo"}</Pill>
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-3">
            Local-first · Windows · MIT licensed
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {ready ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void useUpdater.getState().restart()}
            >
              Restart to install {ready}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={checking || !!downloading}
              onClick={() => void useUpdater.getState().checkNow()}
            >
              {checking
                ? "Checking…"
                : downloading
                  ? "Downloading…"
                  : "Check for updates"}
            </Button>
          )}
        </div>
      </div>
      <div className="border-t border-line bg-base px-4 py-3">
        <div className="flex items-center gap-2 text-[12px]">
          {ready && <Pill tone="success">{ready} downloaded</Pill>}
          <span className={error ? "text-warn" : "text-ink-2"}>
            {status ??
              "Updates install themselves from GitHub Releases — on launch, when you refocus the window, and every few hours."}
          </span>
        </div>
      </div>
    </section>
  );
}
