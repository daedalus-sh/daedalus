import Foundation

/// How numbers read on a small screen.
nonisolated enum Format {
    static func bytes(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "–" }
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .binary)
    }

    static func percent(_ value: Double?, digits: Int = 0) -> String {
        guard let value, value.isFinite else { return "–" }
        return value.formatted(.number.precision(.fractionLength(digits))) + "%"
    }

    static func celsius(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "–" }
        return "\(Int(value.rounded()))°"
    }

    /// "3d 4h", "5h 12m", "42m", "8s".
    static func duration(seconds: Double?) -> String {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return "–" }
        let s = Int(seconds)
        let (d, h, m) = (s / 86_400, (s % 86_400) / 3_600, (s % 3_600) / 60)
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m" }
        return "\(s)s"
    }

    /// An ISO 8601 instant, with or without fractional seconds.
    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = iso.contains(".")
            ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return formatter.date(from: iso)
    }

    static func ago(_ iso: String?, now: Date = .now) -> String {
        guard let date = date(iso) else { return "–" }
        return ago(seconds: now.timeIntervalSince(date))
    }

    static func ago(seconds: Double?) -> String {
        guard let seconds, seconds.isFinite else { return "–" }
        if seconds < 5 { return "now" }
        return duration(seconds: seconds) + " ago"
    }

    static func fraction(used: Double?, total: Double?) -> Double? {
        guard let used, let total, total > 0 else { return nil }
        return min(max(used / total, 0), 1)
    }
}
