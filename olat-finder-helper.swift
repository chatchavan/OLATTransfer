// Compiled by ensure_finder_helper (olat-common.sh) into OLATFinderHelper.app
// so macOS's Automation permission for controlling Finder is tracked as its
// own specific entry in System Settings -> Privacy & Security -> Automation,
// not as generic /bin/bash (which would cover every bash script on the
// machine) and not silently bubbled up to whatever invoked it either.
//
// Getting a genuinely distinct, prompted, persisted TCC entry took three
// things together, confirmed by live testing - dropping any one of them
// goes back to either a silent no-op grant via the parent process, or a
// silent denial with no prompt ever shown:
//   1. A real NSApplication with an actual run loop, not a plain
//      command-line-style Foundation binary. A bare CLI-style binary's
//      Apple Events get attributed to whatever process invoked it (bash,
//      Terminal) instead of being tracked on its own.
//   2. Launched via `open` (LaunchServices), not a direct exec of
//      Contents/MacOS/<binary>. See call_finder_helper in olat-common.sh -
//      `open` doesn't forward stdout, so the result comes back via a
//      throwaway output file instead.
//   3. NSAppleEventsUsageDescription declared in Info.plist. Without it,
//      request are silently auto-denied (-1743) with no prompt at all,
//      even from a real app in a real interactive session - not just
//      "no dialog because nobody can see it," genuinely never asked.
//
// An earlier compiled AppleScript "applet" (via osacompile) was tried and
// rejected before this: invoked directly it never exits, and its argv
// handling breaks outside of `open -a ... --args`. A plain Foundation
// (no Cocoa) binary was tried next and got neither a prompt nor its own
// entry - just silent inherited access via whatever ran it. This is the
// version that actually works.
//
// Usage: OLATFinderHelper <eject|check-window> <arg> <output-file>
// Writes its result (a plain string, or "ERROR: ...") to <output-file> and
// quits itself - never left running.

import Cocoa

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

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        guard args.count >= 4 else {
            NSApp.terminate(nil)
            return
        }
        let cmd = args[1]
        let param = args[2]
        let outputPath = args[3]

        var output = "ERROR: unknown command \(cmd)"
        switch cmd {
        case "eject":
            let source = "tell application \"Finder\" to eject \"\(escape(param))\""
            let (_, err) = runAppleScript(source)
            output = err != nil ? "ERROR: \(err!)" : "OK"
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
            output = err != nil ? "ERROR: \(err!)" : (result ?? "0")
        default:
            break
        }

        try? output.write(toFile: outputPath, atomically: true, encoding: .utf8)
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
