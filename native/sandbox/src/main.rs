// Modified for Pi's speculative-action sandbox migration.
fn main() {
    std::process::exit(pi_sandbox_native::native_main(std::env::args_os()));
}
