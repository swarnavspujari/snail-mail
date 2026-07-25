//! Dev utility: seed or check Snail Mail keychain entries without launching
//! the app. Values come from the SNAIL_SECRET_VALUE env var (legacy
//! FISSION_SECRET_VALUE still accepted) — never from argv, never printed — so
//! secrets stay out of shell history and logs.
//!
//! Gated behind the `dev-secrets` cargo feature so a release build never
//! produces the exe — Cargo auto-discovery plus tauri-cli's external-binary
//! bundling used to ship this keychain writer inside the installed app dir.
//! See the `[[bin]]` block in Cargo.toml.
//!
//!   SNAIL_SECRET_VALUE=... cargo run --features dev-secrets --bin dev-secrets -- set ai:nim
//!   cargo run --features dev-secrets --bin dev-secrets -- check ai:nim
//!   cargo run --features dev-secrets --bin dev-secrets -- delete ai:nim

const SERVICE: &str = "SnailMail";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (cmd, name) = match (args.get(1), args.get(2)) {
        (Some(c), Some(n)) => (c.as_str(), n.as_str()),
        _ => {
            eprintln!("usage: dev-secrets <set|check|delete> <entry-name>");
            std::process::exit(2);
        }
    };
    let entry = keyring::Entry::new(SERVICE, name).expect("keychain unavailable");
    match cmd {
        "set" => {
            let value = std::env::var("SNAIL_SECRET_VALUE")
                .or_else(|_| std::env::var("FISSION_SECRET_VALUE"))
                .expect("SNAIL_SECRET_VALUE env var not set");
            entry.set_password(value.trim()).expect("could not write to keychain");
            println!("stored {name} ({} chars)", value.trim().len());
        }
        "check" => match entry.get_password() {
            Ok(v) => println!("{name}: present ({} chars)", v.len()),
            Err(_) => {
                println!("{name}: missing");
                std::process::exit(1);
            }
        },
        "delete" => {
            let _ = entry.delete_credential();
            println!("deleted {name}");
        }
        _ => {
            eprintln!("unknown command {cmd}");
            std::process::exit(2);
        }
    }
}
