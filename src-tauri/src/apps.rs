//! App identity (friendly names) + process-path utilities — port of
//! electron/main/apps.ts. Icon extraction moved to the icon module (Win32).

const NAME_MAP: &[(&str, &str)] = &[
    ("chrome", "Google Chrome"),
    ("msedge", "Microsoft Edge"),
    ("firefox", "Firefox"),
    ("brave", "Brave"),
    ("opera", "Opera"),
    ("vivaldi", "Vivaldi"),
    ("arc", "Arc"),
    ("code", "VS Code"),
    ("windowsterminal", "Windows Terminal"),
    ("wt", "Windows Terminal"),
    ("powershell", "PowerShell"),
    ("pwsh", "PowerShell"),
    ("cmd", "Command Prompt"),
    ("conhost", "Console"),
    ("devenv", "Visual Studio"),
    ("rider64", "Rider"),
    ("clion64", "CLion"),
    ("pycharm64", "PyCharm"),
    ("webstorm64", "WebStorm"),
    ("idea64", "IntelliJ IDEA"),
    ("goland64", "GoLand"),
    ("zed", "Zed"),
    ("sublime_text", "Sublime Text"),
    ("notepad", "Notepad"),
    ("notepad3", "Notepad3"),
    ("obsidian", "Obsidian"),
    ("typora", "Typora"),
    ("electron", "Electron"),
    ("1boost", "1Boost"),
    ("explorer", "File Explorer"),
    ("dllhost", "COM Surrogate"),
    ("searchhost", "Windows Search"),
    ("searchapp", "Windows Search"),
    ("textinputhost", "Text Input"),
    ("startmenuexperiencehost", "Start Menu"),
    ("runtimebroker", "Runtime Broker"),
    ("applicationframehost", "UWP Apps"),
    ("systemsettings", "Windows Settings"),
    ("taskmgr", "Task Manager"),
    ("regedit", "Registry Editor"),
    ("steam", "Steam"),
    ("steamwebhelper", "Steam"),
    ("discord", "Discord"),
    ("slack", "Slack"),
    ("teams", "Microsoft Teams"),
    ("msteams", "Microsoft Teams"),
    ("msedgewebview2", "Edge WebView"),
    ("spotify", "Spotify"),
    ("spotify_new", "Spotify"),
    ("vlc", "VLC"),
    ("vmware", "VMware Workstation"),
    ("virtualbox", "VirtualBox"),
    ("virtualboxvm", "VirtualBox VM"),
    ("docker", "Docker Desktop"),
    ("postman", "Postman"),
    ("obs64", "OBS Studio"),
    ("godot", "Godot"),
    ("unity", "Unity Hub"),
    ("radeonsoftware", "AMD Software"),
    ("nvidia app", "NVIDIA App"),
    ("nv_container", "NVIDIA Container"),
    ("wallpaper32", "Wallpaper Engine"),
    ("utorrent", "uTorrent"),
    ("qbittorrent", "qBittorrent"),
    ("winrar", "WinRAR"),
    ("7zfg", "7-Zip"),
    ("7zfm", "7-Zip"),
    ("totalcmd", "Total Commander"),
    ("doublecmd", "Double Commander"),
    ("everything", "Everything"),
    ("winword", "Microsoft Word"),
    ("excel", "Microsoft Excel"),
    ("powerpnt", "Microsoft PowerPoint"),
    ("outlook", "Microsoft Outlook"),
    ("onenote", "OneNote"),
    ("figma", "Figma"),
    ("canva", "Canva"),
    ("hl2", "Half-Life 2"),
    ("javaw", "Minecraft: Java Edition"),
    ("zenlesszonezero", "Zenless Zone Zero"),
    ("minecraft", "Minecraft"),
    ("minecraftlauncher", "Minecraft Launcher"),
    ("valorant", "VALORANT"),
    ("valorant_win64", "VALORANT"),
    ("leagueclient", "League of Legends"),
    ("leagueclientux", "League of Legends"),
    ("cs2", "Counter-Strike 2"),
    ("csgo", "Counter-Strike 2"),
    ("gtav", "Grand Theft Auto V"),
    ("rdr2", "Red Dead Redemption 2"),
    ("eldenring", "Elden Ring"),
    ("cyberpunk2077", "Cyberpunk 2077"),
    ("scpcontbreachdlc", "SCP: Containment Breach"),
    ("robloxplayerbeta", "Roblox"),
    ("wt_client", "Wallpaper Engine"),
];

const GENERIC_NAMES: &[&str] = &[
    "applicationframehost", "runtimebroker", "textinputhost", "searchhost", "searchapp",
    "startmenuexperiencehost", "dllhost", "conhost", "svchost", "csrss", "winlogon",
    "wininit", "services", "lsass", "smss", "fontdrvhost", "dwm", "ctfmon", "sihost",
    "taskhostw", "shellhost", "msdtc", "spoolsv", "wmiprvse", "audiodg", "wudfhost",
    "securityhealthservice", "securityhealthsystray", "lockapp", "noise",
];

/// Base name without extension, lowercased (the app "key").
pub fn app_key_from_path(p: &str) -> String {
    let name = p.rsplit(['\\', '/']).next().unwrap_or(p).to_lowercase();
    match name.rfind('.') {
        Some(idx) if idx > 0 => name[..idx].to_string(),
        _ => name,
    }
}

/// Human-friendly display name for an app key or full path.
pub fn app_display_name(path_or_key: &str) -> String {
    let key = app_key_from_path(path_or_key);
    if let Some((_, name)) = NAME_MAP.iter().find(|(k, _)| *k == key) {
        return name.to_string();
    }
    let base = path_or_key.rsplit(['\\', '/']).next().unwrap_or(path_or_key);
    let stem = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".dll")).unwrap_or(base);
    if stem.is_empty() {
        return if path_or_key.is_empty() { "Unknown".into() } else { path_or_key.into() };
    }
    let cleaned = stem.replace('_', " ").trim().to_string();
    let mut c = cleaned.chars();
    match c.next() {
        Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
        None => "Unknown".into(),
    }
}

/// True if this process is a Windows shell/system process (excluded from tracking).
pub fn is_system_app(key: &str) -> bool {
    GENERIC_NAMES.contains(&key)
}
