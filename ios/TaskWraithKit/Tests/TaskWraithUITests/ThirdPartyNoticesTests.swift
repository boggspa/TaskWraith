import Foundation
import Testing

@testable import TaskWraithUI

@Suite("Bundled license notices")
struct ThirdPartyNoticesTests {
    @Test("TaskWraith license is bundled")
    func taskWraithLicenseIsBundled() throws {
        let text = try TaskWraithLicenseResource.taskWraith.text()

        #expect(text.contains("Apache License"))
        #expect(text.contains("Version 2.0, January 2004"))
    }

    @Test("Resolved Swift package notices are bundled")
    func swiftPackageNoticesAreBundled() throws {
        let text = try TaskWraithLicenseResource.thirdParty.text()

        #expect(text.contains("Resolved Swift package identities: 3"))
        #expect(text.contains("Preserved upstream notice sources: 5"))
        #expect(text.contains("592434a103a4d1ab83e14f87ac6eef569dd7a99d"))
        #expect(text.contains("98be227227af10cc7a269cb3ffb23686c0610b17"))
        #expect(text.contains("15cf3a9ec3ab95e0d058b7df9f35619123c9e02d"))
        #expect(text.contains("Copyright © 1991-2019 Unicode, Inc."))
        #expect(text.contains("tree-sitter-swift"))
    }
}
