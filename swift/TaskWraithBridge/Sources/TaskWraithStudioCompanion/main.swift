import Foundation

@main
struct TaskWraithStudioCompanion {
    static func main() {
        let stdin = FileHandle.standardInput
        let stdout = FileHandle.standardOutput

        // Companion-driven hello (version negotiation)
        let hello: [String: Any] = [
            "jsonrpc": "2.0",
            "id": 1,
            "method": "studio/hello",
            "params": ["protocolVersion": "1.0.0"]
        ]
        let helloData = try! JSONSerialization.data(withJSONObject: hello)
        try! stdout.write(contentsOf: helloData + [UInt8(0x0A)])

        // Read responses until EOF
        while true {
            let data = stdin.availableData
            if data.isEmpty {
                // EOF → exit cleanly
                exit(0)
            }
            // NDJSON processing would go here
            // For now, just echo the first line as getDocument
            if let line = String(data: data, encoding: .utf8)?.split(separator: "\n").first {
                let getDoc: [String: Any] = [
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "studio/getDocument",
                    "params": ["documentId": "default"]
                ]
                let getDocData = try! JSONSerialization.data(withJSONObject: getDoc)
                try! stdout.write(contentsOf: getDocData + [UInt8(0x0A)])
            }
        }
    }
}