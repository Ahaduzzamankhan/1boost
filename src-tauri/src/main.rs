// 1Boost desktop binary — thin shell over the Tauri backend library.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    oneboost_lib::run()
}
