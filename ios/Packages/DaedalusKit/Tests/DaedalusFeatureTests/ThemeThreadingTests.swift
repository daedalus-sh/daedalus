@testable import DaedalusFeature
import SwiftUI
import Testing
import UIKit

/// SwiftUI resolves colors and asks shapes for their paths on its async render thread while something
/// animates. With this package's default main-actor isolation, a provider that is main-actor code traps
/// there (`_dispatch_assert_queue_fail`) and nothing warns at compile time. These do both off the main
/// thread; a regression traps the test run.
struct ThemeThreadingTests {
    @Test func themeColorsResolveOffTheMainThread() async {
        let brand = DS.brand
        let red: Double = await Task.detached {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            UIColor(brand).resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
                .getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            return Double(red)
        }.value
        #expect(abs(red - Double(0xE2) / 255) < 0.01)
    }

    @Test func theMarkDrawsOffTheMainThread() async {
        let empty = await Task.detached {
            LabyrinthMark().path(in: CGRect(x: 0, y: 0, width: 64, height: 64)).isEmpty
        }.value
        #expect(!empty)
    }
}
