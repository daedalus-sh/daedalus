import SwiftUI
import UIKit

/// Daedalus on a phone looks like iOS: system surfaces, system type, SF Symbols. What it brings of its own
/// is one accent (the web app's `--primary`, in the asset catalog as AccentColor) and a level's colour.
enum DS {
    static let brand = Color(light: 0xE2795A, dark: 0xE2795A)
    static let radius: CGFloat = 14
    static let gap: CGFloat = 12

    static func mono(_ style: Font.TextStyle = .footnote) -> Font { .system(style, design: .monospaced) }
}

/// How well something is doing, as the whole app colours it.
nonisolated enum Level: Hashable, Sendable {
    case ok, warn, bad, idle

    var color: Color {
        switch self {
        case .ok: .green
        case .warn: .orange
        case .bad: .red
        case .idle: .secondary
        }
    }

    var symbol: String {
        switch self {
        case .ok: "checkmark.circle.fill"
        case .warn: "exclamationmark.triangle.fill"
        case .bad: "xmark.octagon.fill"
        case .idle: "circle.dashed"
        }
    }

    /// A share of something finite (a disk, memory): amber from 80%, red from 92%.
    static func usage(_ fraction: Double?) -> Level {
        guard let fraction else { return .idle }
        if fraction >= 0.92 { return .bad }
        if fraction >= 0.80 { return .warn }
        return .ok
    }
}

extension Color {
    /// A color that follows the light/dark appearance, from two `0xRRGGBB` values.
    ///
    /// The provider must stay `@Sendable` (nonisolated). SwiftUI resolves colors on its async render thread
    /// while something animates; a provider inferred as main-actor code (this package's default isolation)
    /// traps there with `_dispatch_assert_queue_fail`. `ThemeThreadingTests` guards it.
    nonisolated init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { @Sendable traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255,
                           green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255,
                           alpha: 1)
        })
    }
}

/// The daedalus mark: a square labyrinth drawn as one unbroken line (the web app's icon.svg).
/// Nonisolated with plain values only: SwiftUI may ask a shape for its path off the main thread.
nonisolated struct LabyrinthMark: Shape {
    func path(in rect: CGRect) -> Path {
        let points: [(CGFloat, CGFloat)] = [
            (16, 16), (16, 20), (12, 20), (12, 12), (20, 12), (20, 24), (8, 24),
            (8, 8), (24, 8), (24, 28), (4, 28), (4, 4), (28, 4),
        ]
        let scale = min(rect.width, rect.height) / 32
        var path = Path()
        for (index, point) in points.enumerated() {
            let at = CGPoint(x: rect.minX + point.0 * scale, y: rect.minY + point.1 * scale)
            if index == 0 { path.move(to: at) } else { path.addLine(to: at) }
        }
        return path
    }
}
