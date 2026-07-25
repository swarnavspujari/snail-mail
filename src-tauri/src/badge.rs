//! Unread badge: how many unread conversations are sitting in the Important
//! (primary) split, summed across connected accounts — Superhuman's dock badge,
//! on the Windows taskbar, the macOS dock and the Linux launcher.
//!
//! Counting is shared; only `apply` forks, because the platforms disagree about
//! who draws the badge:
//!
//! * **Windows** has no count API at all (`set_badge_count` is documented
//!   unsupported there) — it takes a taskbar *overlay icon*, so we draw the
//!   digits ourselves and hand over a 32×32 image.
//! * **macOS / Linux** take the number and render it natively:
//!   `set_badge_count` becomes the dock tile's badge label on macOS and the
//!   Unity launcher count on Linux/BSD.
//!
//! So the count is capped to "9+" only where we're doing the drawing; macOS and
//! Linux show the true number, which is the convention on both (Mail.app badges
//! four digits happily) and strictly more informative than a cap we only need
//! because three digits don't survive a 16×16 taskbar overlay.
//!
//! Two more shapes worth knowing:
//!
//! * **Drawn, not decoded.** The `image-png` / `image-ico` cargo features are
//!   off, so `Image::from_bytes` doesn't exist for us. `render` builds the
//!   32×32 RGBA buffer by hand instead — a filled disc plus a scaled 3×5
//!   bitmap digit. That keeps the badge dependency-free and makes the whole
//!   drawing path a pure function the tests can pin down.
//! * **Rust-driven, so no ACL.** A JS-driven badge would need
//!   `core:window:allow-set-overlay-icon` in `capabilities/default.json`;
//!   driving it from here needs nothing.
//!
//! The browser demo has no launcher of any kind and never reaches this module.
//!
//! Staleness is handled structurally: `refresh` hangs off `emit_mail_updated`
//! (lib.rs), the single funnel every `mail:updated` producer goes through, so
//! a future emit site picks the badge up for free.
//!
//! Known platform limit: the Linux count goes through the Unity launcher
//! protocol via libunity, and tao only forwards it when libunity is present
//! AND reports the Unity shell running — so in practice only Unity desktops
//! (and setups emulating it) render a count; GNOME and KDE silently ignore
//! it. The call is harmless where nothing listens.

use crate::{store, AppState};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

/// The split the badge counts. `goto.inbox` lands here (`lib/commands.ts`) and
/// the thread list opens here (`stores/mail.ts`), so "primary" means the same
/// thing on both sides of the IPC seam. A user who deletes the builtin
/// Important split gets a badge of 0 — matching the tab they no longer have.
pub const PRIMARY_SPLIT_ID: &str = "important";

/// Overlay icons are composited at ~16×16 on the taskbar; drawing at 32 and
/// letting Windows downsample gives the disc a clean edge.
const SIZE: u32 = 32;
/// The light-theme `--danger` token, oklch(0.52 0.19 27) → sRGB. Red rather
/// than the cyan `--accent` because the badge lands on the white Paper tile,
/// where an alert red is both legible and the conventional unread signal.
const FILL: [u8; 3] = [189, 35, 35];
const INK: [u8; 3] = [255, 255, 255];

/// 3×5 bitmap glyphs, one `u8` per row, bit 2 = leftmost column. Ten digits
/// plus the `+` that the cap needs — a real font crate would be a dependency
/// and several kilobytes to draw at most two characters.
const GLYPHS: [(char, [u8; 5]); 11] = [
    ('0', [0b111, 0b101, 0b101, 0b101, 0b111]),
    ('1', [0b010, 0b110, 0b010, 0b010, 0b111]),
    ('2', [0b111, 0b001, 0b111, 0b100, 0b111]),
    ('3', [0b111, 0b001, 0b111, 0b001, 0b111]),
    ('4', [0b101, 0b101, 0b111, 0b001, 0b001]),
    ('5', [0b111, 0b100, 0b111, 0b001, 0b111]),
    ('6', [0b111, 0b100, 0b111, 0b101, 0b111]),
    ('7', [0b111, 0b001, 0b001, 0b001, 0b001]),
    ('8', [0b111, 0b101, 0b111, 0b101, 0b111]),
    ('9', [0b111, 0b101, 0b111, 0b001, 0b111]),
    ('+', [0b000, 0b010, 0b111, 0b010, 0b000]),
];

fn glyph(ch: char) -> Option<[u8; 5]> {
    GLYPHS.iter().find(|(c, _)| *c == ch).map(|(_, rows)| *rows)
}

/// What the *drawn* badge reads (Windows). Two characters is the ceiling: at
/// 16×16 a third digit is a smudge, so everything past nine collapses to "9+".
/// macOS and Linux never come through here — they're handed the raw count.
pub fn label(count: i64) -> String {
    if count > 9 {
        "9+".into()
    } else {
        count.max(0).to_string()
    }
}

/// The badge as 32×32 straight-alpha RGBA, row-major top to bottom — exactly
/// what `Image::new_owned` wants.
///
/// Every pixel carries the fill colour even where it's fully transparent, so
/// a compositor that assumes premultiplied alpha can't fringe the disc's
/// antialiased edge with black.
pub fn render(count: i64) -> Vec<u8> {
    let mut buf = vec![0u8; (SIZE * SIZE * 4) as usize];
    let center = SIZE as f32 / 2.0;
    // Half a pixel in from the edge leaves room for the antialiased rim.
    let radius = SIZE as f32 / 2.0 - 0.5;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - center;
            let dy = y as f32 + 0.5 - center;
            let coverage = (radius + 0.5 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);
            let i = ((y * SIZE + x) * 4) as usize;
            buf[i] = FILL[0];
            buf[i + 1] = FILL[1];
            buf[i + 2] = FILL[2];
            buf[i + 3] = (coverage * 255.0).round() as u8;
        }
    }

    let text = label(count);
    let glyphs = text.chars().count() as u32;
    // One digit fills ~62% of the height; two need to shrink to stay inside
    // the disc (a 20×15 block's corners sit 12.8px from a 15.5px radius).
    let (scale, gap) = if glyphs <= 1 { (4u32, 0u32) } else { (3u32, 2u32) };
    let glyph_w = 3 * scale;
    let text_w = glyphs * glyph_w + glyphs.saturating_sub(1) * gap;
    let text_h = 5 * scale;
    let x0 = (SIZE - text_w) / 2;
    let y0 = (SIZE - text_h) / 2;
    for (gi, ch) in text.chars().enumerate() {
        let Some(rows) = glyph(ch) else { continue };
        let gx = x0 + gi as u32 * (glyph_w + gap);
        for (ry, row) in rows.iter().enumerate() {
            for cx in 0..3u32 {
                if row & (1 << (2 - cx)) == 0 {
                    continue;
                }
                for sy in 0..scale {
                    for sx in 0..scale {
                        let px = gx + cx * scale + sx;
                        let py = y0 + ry as u32 * scale + sy;
                        let i = ((py * SIZE + px) * 4) as usize;
                        buf[i] = INK[0];
                        buf[i + 1] = INK[1];
                        buf[i + 2] = INK[2];
                        buf[i + 3] = 255;
                    }
                }
            }
        }
    }
    buf
}

/// Unread conversations in the primary split across every account that isn't
/// mid-removal. `disconnect_account` flags `removing` and emits `mail:updated`
/// before the teardown even starts, so the badge drops that account's mail the
/// instant the user disconnects — and clears entirely when the last one goes.
///
/// Returns 0 when the setting is off, which clears the overlay the same way an
/// empty inbox does.
fn count_unread_primary(app: &AppHandle) -> i64 {
    let state = app.state::<AppState>();
    let (show, emails) = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        let show = store::get_settings(&conn).show_badge;
        let emails: Vec<String> = store::get_accounts(&conn)
            .accounts
            .iter()
            .filter(|a| !a.removing)
            .map(|a| a.email.clone())
            .collect();
        (show, emails)
    };
    if !show {
        return 0;
    }
    let mut total = 0i64;
    for email in &emails {
        let Ok(db) = state.account_db(email) else { continue };
        let conn = db.lock().unwrap();
        total += store::count_unread_in_split(&conn, email, PRIMARY_SPLIT_ID);
    }
    total
}

/// Recount and repaint. Off-thread on purpose: this is called from the
/// `mail:updated` funnel, whose ~20 producers can't all be audited for what
/// they're holding, and the per-account `Mutex<Connection>` is not reentrant.
/// Hopping to the blocking pool means the funnel can never deadlock a caller
/// against its own database lock.
pub fn refresh(app: &AppHandle) {
    // Newest-wins sequencing: concurrent refreshes recount in parallel, but a
    // stale result is dropped instead of painting over a newer one.
    static GEN: AtomicU64 = AtomicU64::new(0);
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let count = count_unread_primary(&app);
        if GEN.load(Ordering::SeqCst) == gen {
            apply(&app, count);
        }
    });
}

#[cfg(target_os = "windows")]
fn apply(app: &AppHandle, count: i64) {
    use tauri::image::Image;
    let Some(win) = app.get_webview_window("main") else { return };
    let icon = (count > 0).then(|| Image::new_owned(render(count), SIZE, SIZE));
    if let Err(e) = win.set_overlay_icon(icon) {
        eprintln!("[badge] {e}");
    }
}

/// macOS and Linux both take the number itself and draw it themselves —
/// `set_badge_count` is the one call, mapping to the dock tile's badge label on
/// macOS and to the Unity launcher count on Linux/BSD. Nothing to render, so
/// the digit bitmap above is Windows-only in practice.
///
/// `None` rather than `Some(0)` clears it: Tauri documents zero as "remove",
/// but on macOS the runtime stringifies whatever it's given, so `Some(0)` would
/// paint a literal "0" on the dock.
#[cfg(not(target_os = "windows"))]
fn apply(app: &AppHandle, count: i64) {
    let Some(win) = app.get_webview_window("main") else { return };
    if let Err(e) = win.set_badge_count((count > 0).then_some(count)) {
        eprintln!("[badge] {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(buf: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    /// Pixels drawn in white — the digit itself.
    fn ink(buf: &[u8]) -> Vec<(u32, u32)> {
        let mut out = vec![];
        for y in 0..SIZE {
            for x in 0..SIZE {
                if px(buf, x, y) == [INK[0], INK[1], INK[2], 255] {
                    out.push((x, y));
                }
            }
        }
        out
    }

    #[test]
    fn label_caps_at_nine_plus() {
        assert_eq!(label(1), "1");
        assert_eq!(label(9), "9");
        assert_eq!(label(10), "9+");
        assert_eq!(label(4821), "9+");
        // Never rendered (zero clears the overlay), but defined rather than
        // panicking if a caller ever asks.
        assert_eq!(label(0), "0");
        assert_eq!(label(-3), "0");
    }

    #[test]
    fn buffer_is_32x32_rgba_with_transparent_corners() {
        let buf = render(1);
        assert_eq!(buf.len(), (SIZE * SIZE * 4) as usize);
        for (x, y) in [(0, 0), (31, 0), (0, 31), (31, 31)] {
            assert_eq!(px(&buf, x, y)[3], 0, "corner ({x},{y}) must be transparent");
        }
    }

    #[test]
    fn disc_is_opaque_fill_and_the_rim_fades() {
        let buf = render(3);
        // Just inside the circle, off the digit: solid fill.
        assert_eq!(px(&buf, 3, 16), [FILL[0], FILL[1], FILL[2], 255]);
        // The rim is antialiased, not a hard edge.
        let rim = px(&buf, 0, 16);
        assert!(rim[3] > 0 && rim[3] < 255, "rim alpha {} should be partial", rim[3]);
        // Transparent pixels still carry the fill colour, so a premultiplying
        // compositor can't fringe the edge black.
        assert_eq!(px(&buf, 0, 0)[..3], FILL[..]);
    }

    #[test]
    fn each_count_renders_its_own_glyphs() {
        // A one is the sparsest digit, an eight the densest.
        assert!(ink(&render(1)).len() < ink(&render(8)).len());
        // Distinct digits, distinct pixels — the table isn't wired to one glyph.
        for a in 1..=9i64 {
            for b in 1..=9i64 {
                if a != b {
                    assert_ne!(ink(&render(a)), ink(&render(b)), "{a} and {b} render alike");
                }
            }
        }
        // The cap is two glyphs, so it inks more columns than any single digit.
        let cols = |c: i64| {
            let mut xs: Vec<u32> = ink(&render(c)).iter().map(|(x, _)| *x).collect();
            xs.sort_unstable();
            xs.dedup();
            xs.len()
        };
        assert!(cols(10) > cols(9), "'9+' should be wider than '9'");
        assert_eq!(ink(&render(10)), ink(&render(999)), "everything past 9 is '9+'");
    }

    #[test]
    fn every_inked_pixel_sits_inside_the_disc() {
        let center = SIZE as f32 / 2.0;
        let radius = SIZE as f32 / 2.0 - 0.5;
        for count in [1i64, 4, 8, 9, 10, 250] {
            for (x, y) in ink(&render(count)) {
                let dx = x as f32 + 0.5 - center;
                let dy = y as f32 + 0.5 - center;
                let d = (dx * dx + dy * dy).sqrt();
                assert!(d <= radius - 1.0, "count {count}: ({x},{y}) is {d:.1} from center");
            }
        }
    }

    #[test]
    fn glyphs_are_centered() {
        // Vertical + horizontal symmetry of the ink bounding box: an
        // off-centre digit reads as a rendering bug at 16×16.
        for count in [1i64, 5, 10] {
            let ink = ink(&render(count));
            let (min_x, max_x) = (
                ink.iter().map(|(x, _)| *x).min().unwrap(),
                ink.iter().map(|(x, _)| *x).max().unwrap(),
            );
            let (min_y, max_y) = (
                ink.iter().map(|(_, y)| *y).min().unwrap(),
                ink.iter().map(|(_, y)| *y).max().unwrap(),
            );
            // '1' is drawn with a serif foot so its own box is symmetric.
            assert!(
                (min_x as i32 - (SIZE - 1 - max_x) as i32).abs() <= 1,
                "count {count}: horizontal margins {min_x} vs {}",
                SIZE - 1 - max_x
            );
            assert!(
                (min_y as i32 - (SIZE - 1 - max_y) as i32).abs() <= 1,
                "count {count}: vertical margins {min_y} vs {}",
                SIZE - 1 - max_y
            );
        }
    }
}
