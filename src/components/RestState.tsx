// Empty inbox / empty split rest state: a calm daily Unsplash photo behind
// the inbox-zero copy, with the guideline-required attribution. The photo is
// hotlinked (blur-hash placeholder while it loads) and falls back to the
// byte cache offline; showing it fires the download event exactly once.
//
// It turns over at 12:01 AM local. The core enforces that boundary on the
// cache (unsplash.rs `photo_day`); this component has to actually go and ASK
// at the boundary, because an app sitting at inbox zero never remounts.
import { useCallback, useEffect, useRef, useState } from "react";
import { backend, openExternal } from "@/lib/ipc";
import { decodeBlurHash } from "@/lib/blurhash";
import { msUntilNextRotation, photoIsStale } from "@/lib/daily-photo";
import { useSettings } from "@/stores/settings";
import type { DailyPhoto } from "@/lib/types";

const UNSPLASH_HOME =
  "https://unsplash.com/?utm_source=snail_mail&utm_medium=referral";

function BlurCanvas({ hash }: { hash: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const pixels = decodeBlurHash(hash, 32, 20);
    const ctx = ref.current?.getContext("2d");
    if (!pixels || !ctx) return;
    ctx.putImageData(
      new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, 32, 20),
      0,
      0
    );
  }, [hash]);
  return (
    <canvas
      ref={ref}
      width={32}
      height={20}
      aria-hidden
      className="absolute inset-0 h-full w-full"
    />
  );
}

/** Inbox-zero rest state: just the daily photo, with the inbox-zero streak
 *  bottom-left and the Unsplash attribution bottom-right. No overlaid copy.
 *  `labelOffset` lifts the streak + attribution above the shortcut-hint
 *  footer when the photo fills the whole app behind it. */
export function RestState({ labelOffset = 10 }: { labelOffset?: number }) {
  const [photo, setPhoto] = useState<DailyPhoto | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [hotlinkFailed, setHotlinkFailed] = useState(false);
  const streak = useSettings((s) => s.streaks.daily);

  // Kept in a ref as well as state so the rotation effects below can read the
  // current photo without re-subscribing (and re-arming the timer) on every
  // fetch — the timer must survive its own result landing.
  const photoRef = useRef<DailyPhoto | null>(null);
  const load = useCallback(() => {
    void backend
      .getDailyPhoto()
      .then((p) => {
        if (!p) return;
        // Same photo (the core says the day hasn't turned) — leave the loaded
        // <img> alone rather than restarting its fade for no reason.
        if (photoRef.current?.url === p.url) return;
        photoRef.current = p;
        setPhoto(p);
        setImgLoaded(false);
        setHotlinkFailed(false);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Ask again at the next local 12:01 AM, then re-arm from the new "now" —
  // which is also what keeps this correct across DST and across a machine that
  // was asleep when the timer was due.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        load();
        arm();
      }, msUntilNextRotation(new Date()));
    };
    arm();
    return () => clearTimeout(timer);
  }, [load]);

  // A suspended laptop's timers do not fire on schedule, so the boundary can
  // pass with nothing running. Waking the window re-checks the date and only
  // refetches when the day genuinely moved on.
  useEffect(() => {
    const onFocus = () => {
      const p = photoRef.current;
      if (!p || photoIsStale(p.fetchedAt, Date.now())) load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const src =
    photo && hotlinkFailed ? (photo.cachedDataUri ?? photo.url) : photo?.url;
  const streakLabel =
    streak > 0
      ? `🔥 ${streak}-day inbox-zero streak`
      : "Inbox zero";

  return (
    <div className="relative h-full w-full overflow-hidden">
      {photo?.blurHash && !imgLoaded && <BlurCanvas hash={photo.blurHash} />}
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={() => {
            setImgLoaded(true);
            // Unsplash guideline: count the download when first shown
            void backend.photoShown().catch(() => {});
          }}
          onError={() => setHotlinkFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
            imgLoaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
      {/* subtle bottom scrim so the streak + attribution stay legible on any photo */}
      {photo && (
        <div
          className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/45 to-transparent"
          style={{ height: labelOffset + 86 }}
        />
      )}
      {/* no photo (offline / no key): a calm centered fallback */}
      {!photo && (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-ink-3">
          <div className="text-4xl">◎</div>
          <div className="text-[13px]">{streakLabel}</div>
        </div>
      )}
      {photo && (
        <div
          className="absolute left-3.5 text-[12px] font-medium text-white/85 drop-shadow"
          style={{ bottom: labelOffset }}
        >
          {streakLabel}
        </div>
      )}
      {photo && (
        <div
          className="absolute right-3.5 text-[11px] text-white/70"
          style={{ bottom: labelOffset }}
        >
          {photo.authorLink ? (
            <>
              Photo by{" "}
              <button
                className="underline decoration-white/40 hover:text-white"
                onClick={() => void openExternal(photo.authorLink!)}
              >
                {photo.authorName}
              </button>{" "}
              on{" "}
              <button
                className="underline decoration-white/40 hover:text-white"
                onClick={() => void openExternal(UNSPLASH_HOME)}
              >
                Unsplash
              </button>
            </>
          ) : (
            <>{photo.authorName}</>
          )}
        </div>
      )}
    </div>
  );
}
