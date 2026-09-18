// Compiled by ensure_finder_helper (olat-common.sh) into a minimal .app
// bundle so macOS Automation permission for controlling Finder is granted
// to this specific tool, not to the generic /bin/bash binary that would
// otherwise be shown in System Settings -> Privacy & Security -> Automation.
//
// Plain Foundation, no AppKit: this must behave like an ordinary
// command-line tool (parse argv, run, print, exit) rather than a GUI app
// with its own lifecycle - a compiled AppleScript "applet" bundle was
// tried first and never returned when run directly outside of Finder's
// `open`, so this exists instead of that.
//
// Usage:
//   OLATFinderHelper eject <serverName>
//   OLATFinderHelper check-window <posixPathPrefix>

import Foundation

func escape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
}

func runAppleScript(_ source: String) -> (String?, String?) {
    var errorDict: NSDictionary?
    guard let script = NSAppleScript(source: source) else {
        return (nil, "failed to parse AppleScript source")
    }
    let result = script.executeAndReturnError(&errorDict)
    if let errorDict = errorDict {
        return (nil, "\(errorDict)")
    }
    return (result.stringValue, nil)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: OLATFinderHelper <eject|check-window> <arg>\n".data(using: .utf8)!)
    exit(2)
}

let cmd = args[1]
let param = args[2]

switch cmd {
case "eject":
    let source = "tell application \"Finder\" to eject \"\(escape(param))\""
    let (_, err) = runAppleScript(source)
    if let err = err {
        print("ERROR: \(err)")
        exit(1)
    }
    print("OK")
case "check-window":
    let source = """
    tell application "Finder"
        set n to 0
        set winCount to count of windows
        repeat with i from 1 to winCount
            try
                set p to POSIX path of ((target of window i) as alias)
                if p starts with "\(escape(param))" then set n to n + 1
            end try
        end repeat
        return n
    end tell
    """
    let (result, err) = runAppleScript(source)
    if let err = err {
        print("ERROR: \(err)")
        exit(1)
    }
    print(result ?? "0")
default:
    FileHandle.standardError.write("unknown command: \(cmd)\n".data(using: .utf8)!)
    exit(2)
}
