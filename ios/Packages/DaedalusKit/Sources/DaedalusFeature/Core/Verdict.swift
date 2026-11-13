import Foundation

extension Overview {
    /// What needs a look, each as a few words; empty when everything is fine. The overview's headline,
    /// and what the watch shows.
    nonisolated var troubles: [String] {
        var list: [String] = []
        if let firing = alerts.value?.firing, firing > 0 {
            list.append(firing == 1 ? "1 alert firing" : "\(firing) alerts firing")
        }
        if let failing = health.value?.failing, !failing.isEmpty {
            list.append(failing.count == 1 ? "\(failing[0]) is not answering" : "\(failing.count) apps not answering")
        }
        if let host = host.value {
            if !host.containers.down.isEmpty {
                list.append(host.containers.down.count == 1
                    ? "\(host.containers.down[0]) is down" : "\(host.containers.down.count) containers down")
            }
            if !host.failedUnits.isEmpty {
                list.append(host.failedUnits.count == 1 ? "1 failed unit" : "\(host.failedUnits.count) failed units")
            }
        }
        if let storage = storage.value {
            for pool in storage.pools where pool.health != "ONLINE" {
                list.append("\(pool.name) is \(pool.health.lowercased())")
            }
            if storage.disks.contains(where: { $0.passed == false }) { list.append("a drive failed SMART") }
        }
        if let jobs = jobs.value?.trouble, !jobs.isEmpty {
            list.append(jobs.count == 1 ? "1 job in trouble" : "\(jobs.count) jobs in trouble")
        }
        if apply.value?.rebootPending == true { list.append("a reboot is pending") }
        return list
    }
}
