import Cocoa
import Darwin
import Foundation

private struct SetupFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private struct CommandResult {
    let output: String
    let status: Int32
}

@main
final class ProductSetupApp: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        if Array(CommandLine.arguments.dropFirst()) == ["--install-noninteractive"] {
            runNoninteractiveInstall()
        }

        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)

        let confirmation = NSAlert()
        confirmation.messageText = "Install Debrute"
        confirmation.informativeText = "Installs the complete Debrute Product for this user: Desktop, Runtime, debrute CLI, and official Skills. No administrator access is required."
        confirmation.alertStyle = .informational
        confirmation.addButton(withTitle: "Install")
        confirmation.addButton(withTitle: "Cancel")
        guard confirmation.runModal() == .alertFirstButtonReturn else {
            NSApplication.shared.terminate(nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let application = try self.installProduct()
                DispatchQueue.main.async { self.presentSuccess(application) }
            } catch {
                DispatchQueue.main.async { self.presentFailure(error) }
            }
        }
    }

    private func runNoninteractiveInstall() -> Never {
        do {
            let application = try installProduct()
            FileHandle.standardOutput.write(
                Data("Debrute Product installed at \(application.path)\n".utf8)
            )
            exit(EXIT_SUCCESS)
        } catch {
            FileHandle.standardError.write(
                Data("Debrute Product installation failed: \(error.localizedDescription)\n".utf8)
            )
            exit(EXIT_FAILURE)
        }
    }

    private func installProduct() throws -> URL {
        guard let resources = Bundle.main.resourceURL else {
            throw SetupFailure(message: "Product Setup resources are unavailable.")
        }
        let payload = resources.appendingPathComponent("Debrute.app", isDirectory: true)
        let sourceSeed = payload.appendingPathComponent("Contents/Resources/product-seed", isDirectory: true)
        let sourceRuntime = sourceSeed.appendingPathComponent(
            "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime"
        )
        let home = FileManager.default.homeDirectoryForCurrentUser
        let applications = home.appendingPathComponent("Applications", isDirectory: true)
        let destination = applications.appendingPathComponent("Debrute.app", isDirectory: true)

        try requireSuccess(run(sourceRuntime, [
            "preflight-desktop-seed",
            "--seed", sourceSeed.path
        ]), action: "Product preflight")
        try stopInstalledProduct(home: home, application: destination)
        try installDesktopPayload(payload, at: destination, applications: applications)

        let installedSeed = destination.appendingPathComponent(
            "Contents/Resources/product-seed",
            isDirectory: true
        )
        let installedRuntime = installedSeed.appendingPathComponent(
            "runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime"
        )
        let desktopExecutable = destination.appendingPathComponent("Contents/MacOS/Debrute")
        try requireSuccess(run(installedRuntime, [
            "install-product",
            "--seed", installedSeed.path,
            "--desktop-entrypoint", desktopExecutable.path,
            "--desktop-arguments-json", "[]"
        ]), action: "Product installation")
        return destination
    }

    private func stopInstalledProduct(home: URL, application: URL) throws {
        let runtime = home.appendingPathComponent(
            ".debrute/products/current/runtime/Debrute Runtime.app/Contents/MacOS/debrute-runtime"
        )
        if FileManager.default.isExecutableFile(atPath: runtime.path) {
            let result = try run(runtime, ["stop-product-for-installation"])
            if result.status != 0 {
                throw SetupFailure(message: "The installed Debrute Product could not stop.\n\(result.output)")
            }
        }
        let processPrefix = application.appendingPathComponent("Contents").path + "/"
        for _ in 0..<120 {
            let processes = try run(URL(fileURLWithPath: "/bin/ps"), ["-axo", "command="])
            if !processes.output.split(separator: "\n").contains(where: { $0.contains(processPrefix) }) {
                return
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        throw SetupFailure(message: "The installed Debrute Desktop did not exit.")
    }

    private func installDesktopPayload(_ payload: URL, at destination: URL, applications: URL) throws {
        let files = FileManager.default
        try files.createDirectory(at: applications, withIntermediateDirectories: true)
        let nonce = UUID().uuidString
        let staging = applications.appendingPathComponent(".Debrute-install-\(nonce).app")
        do {
            try requireSuccess(
                run(URL(fileURLWithPath: "/usr/bin/ditto"), [payload.path, staging.path]),
                action: "Desktop payload copy"
            )
            if files.fileExists(atPath: destination.path) {
                _ = try files.replaceItemAt(
                    destination,
                    withItemAt: staging,
                    backupItemName: nil,
                    options: []
                )
            } else {
                try files.moveItem(at: staging, to: destination)
            }
        } catch {
            do {
                if files.fileExists(atPath: staging.path) {
                    try files.removeItem(at: staging)
                }
            } catch let cleanupError {
                throw SetupFailure(
                    message: "Desktop installation failed: \(error.localizedDescription)\n" +
                        "Staging cleanup also failed at \(staging.path): \(cleanupError.localizedDescription)"
                )
            }
            throw error
        }
    }

    private func run(_ executable: URL, _ arguments: [String]) throws -> CommandResult {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return CommandResult(
            output: String(decoding: data, as: UTF8.self),
            status: process.terminationStatus
        )
    }

    private func requireSuccess(_ result: CommandResult, action: String) throws {
        if result.status != 0 {
            throw SetupFailure(message: "\(action) failed.\n\(result.output)")
        }
    }

    private func presentSuccess(_ application: URL) {
        let success = NSAlert()
        success.messageText = "Installation Complete"
        success.informativeText = "If an Agent was already open before installation, restart it to load Debrute Skills and the debrute command."
        success.alertStyle = .informational
        success.addButton(withTitle: "Launch Debrute")
        success.addButton(withTitle: "Done")
        if success.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.openApplication(
                at: application,
                configuration: NSWorkspace.OpenConfiguration()
            )
        }
        NSApplication.shared.terminate(nil)
    }

    private func presentFailure(_ error: Error) {
        let failure = NSAlert(error: error)
        failure.messageText = "Debrute Was Not Installed"
        failure.runModal()
        NSApplication.shared.terminate(nil)
    }
}
