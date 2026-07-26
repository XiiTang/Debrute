use std::{env, path::PathBuf};

fn main() {
    println!("cargo::rerun-if-env-changed=DEBRUTE_LIBVIPS_LIB_DIR");
    let target = env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS must be available");
    assert!(
        matches!(target.as_str(), "macos" | "windows"),
        "Debrute Runtime is supported only on macOS and Windows"
    );

    let library_directory = env::var_os("DEBRUTE_LIBVIPS_LIB_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .expect("DEBRUTE_LIBVIPS_LIB_DIR must identify the prepared libvips 8.18.4 payload");
    println!("cargo::rerun-if-changed={}", library_directory.display());
    println!(
        "cargo::rustc-link-search=native={}",
        library_directory.display()
    );
    if target == "windows" {
        println!("cargo::rustc-link-lib=dylib=libglib-2.0");
        println!("cargo::rustc-link-lib=dylib=libgobject-2.0");
    } else {
        println!("cargo::rustc-link-arg=-Wl,-rpath,@loader_path/../libvips");
        println!("cargo::rustc-link-arg-bins=-Wl,-rpath,@loader_path/libvips");
        println!(
            "cargo::rustc-link-arg-bins=-Wl,-rpath,@loader_path/Debrute Runtime.app/Contents/libvips"
        );
    }
}
