import Foundation

/// What travels between the iPhone app and its watch app, over WatchConnectivity's application context
/// (the latest value wins, delivered when the other side next runs). The watch also sends its facts as a
/// message, under the same key, when the iPhone is in reach. Foundation only: both apps build it.
public enum WatchLink {
    /// Watch → iPhone: `WatchFacts`, as JSON.
    public static let factsKey = "watch"
    /// iPhone → watch: `BoxGlance`, as JSON.
    public static let glanceKey = "glance"

    public static func encode<Value: Encodable>(_ value: Value) -> Data? {
        try? JSONEncoder().encode(value)
    }

    public static func decode<Value: Decodable>(_ type: Value.Type, from context: [String: Any], key: String) -> Value? {
        guard let data = context[key] as? Data else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

/// What a watch says about itself. The iPhone reports it to the box as an accessory of its own node.
public struct WatchFacts: Codable, Hashable, Sendable {
    public var name: String
    /// "Watch7,5"
    public var model: String
    public var osVersion: String
    public var osBuild: String?
    /// 0 to 100; nil when the watch does not say.
    public var batteryPercent: Double?
    public var charging: Bool?
    public var lowPower: Bool
    public var storageTotalBytes: Int64?
    public var storageFreeBytes: Int64?
    public var sampledAt: Date

    public init(name: String, model: String, osVersion: String, osBuild: String?, batteryPercent: Double?,
                charging: Bool?, lowPower: Bool, storageTotalBytes: Int64?, storageFreeBytes: Int64?,
                sampledAt: Date) {
        self.name = name
        self.model = model
        self.osVersion = osVersion
        self.osBuild = osBuild
        self.batteryPercent = batteryPercent
        self.charging = charging
        self.lowPower = lowPower
        self.storageTotalBytes = storageTotalBytes
        self.storageFreeBytes = storageFreeBytes
        self.sampledAt = sampledAt
    }
}

/// The box in one glance, as the iPhone last read it: fine, or what is not.
public struct BoxGlance: Codable, Hashable, Sendable {
    public var box: String
    /// Empty: everything is fine.
    public var troubles: [String]
    public var at: Date

    public init(box: String, troubles: [String], at: Date) {
        self.box = box
        self.troubles = troubles
        self.at = at
    }
}
