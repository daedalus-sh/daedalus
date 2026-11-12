//! The link's wire types as the agent names them: the shared crate's
//! (core/src/link/wire.rs), and the golden tests that pin each one's exact
//! JSON beside the agent's own documents.

pub use daedalus_core::link::wire::*;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::claude::Roster;
    use crate::core::config::TelemetryLevel;
    use crate::ipc::rpc::Response;
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    fn wire<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap()
    }

    pub fn hello() -> Hello {
        Hello {
            proto: 1,
            node_id: "0123456789abcdef".into(),
            agent_version: "0.14.0".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            hostname: "PC".into(),
            mac: Some("aa:bb:cc:dd:ee:ff".into()),
            lan_ip: Some("192.168.0.120".into()),
            facts: HelloFacts {
                os_name: "Windows 11 Pro".into(),
                os_version: "24H2".into(),
                cpu: "AMD Ryzen 9".into(),
                memory_bytes: Some(64),
                model: None,
            },
            capabilities: vec![Capability::ClaudeRemoteControl, Capability::TelemetryFull],
            telemetry: TelemetryLevel::Full,
            kind: None,
        }
    }

    #[test]
    fn a_hello_is_held_to_its_bounds() {
        assert!(hello().check().is_ok());
        let mac_name = Hello {
            hostname: "Santiago’s MacBook Pro".into(),
            mac: Some("A4:83:E7:00:11:22".into()),
            ..hello()
        };
        assert!(mac_name.check().is_ok());
        type Edit = Box<dyn Fn(&mut Hello)>;
        let bad: Vec<Edit> = vec![
            Box::new(|h| h.hostname = "x".repeat(254)),
            Box::new(|h| h.hostname = "pc\nevil".into()),
            Box::new(|h| h.hostname = " pc".into()),
            Box::new(|h| h.hostname = String::new()),
            Box::new(|h| h.os = "win dows".into()),
            Box::new(|h| h.arch = "a".repeat(65)),
            Box::new(|h| h.agent_version = "1.0\u{1b}".into()),
            Box::new(|h| h.mac = Some("aa:bb:cc:dd:ee".into())),
            Box::new(|h| h.mac = Some("aa-bb-cc-dd-ee-ff".into())),
            Box::new(|h| h.lan_ip = Some("192.168.0.300".into())),
            Box::new(|h| h.lan_ip = Some("fe80::1".into())),
            Box::new(|h| h.capabilities = vec![Capability::Root; 33]),
            Box::new(|h| h.facts.cpu = "c".repeat(257)),
            Box::new(|h| h.node_id = "xyz".into()),
        ];
        for (i, f) in bad.iter().enumerate() {
            let mut h = hello();
            f(&mut h);
            assert!(h.check().is_err(), "case {i}");
        }
    }

    #[test]
    fn hello_and_welcome_on_the_wire() {
        assert_eq!(
            request(1, name::HELLO, &hello()),
            concat!(
                r#"{"id":1,"m":"hello","p":{"proto":1,"node_id":"0123456789abcdef","#,
                r#""agent_version":"0.14.0","os":"windows","arch":"x86_64","hostname":"PC","#,
                r#""mac":"aa:bb:cc:dd:ee:ff","lan_ip":"192.168.0.120","#,
                r#""facts":{"os_name":"Windows 11 Pro","os_version":"24H2","cpu":"AMD Ryzen 9","memory_bytes":64},"#,
                r#""capabilities":["claude.remote_control","telemetry.full"],"telemetry":"full"}}"#
            )
        );
        let welcome = Welcome {
            proto: 1,
            node_id: "0123456789abcdef".into(),
            state: NodeState::Approved,
            controller: ControllerId {
                version: "0.14.0".into(),
                hostname: "box".into(),
                fingerprint: "3f2a:…".into(),
            },
            policy: Some(Policy {
                awake_hold: false,
                claude_remote_control: true,
                claude_workdir: Some("C:/p".into()),
                ..Default::default()
            }),
        };
        assert_eq!(
            wire(&Response::ok(1, &welcome)),
            concat!(
                r#"{"id":1,"ok":{"proto":1,"node_id":"0123456789abcdef","state":"approved","#,
                r#""controller":{"version":"0.14.0","hostname":"box","fingerprint":"3f2a:…"},"#,
                r#""policy":{"awake_hold":false,"claude_remote_control":true,"claude_workdir":"C:/p"}}}"#
            )
        );
        let pending = Welcome {
            state: NodeState::Pending,
            policy: None,
            ..welcome
        };
        assert!(wire(&pending).ends_with(r#""state":"pending","controller":{"version":"0.14.0","hostname":"box","fingerprint":"3f2a:…"},"policy":null}"#));
        // A newer peer's extra fields are ignored both ways.
        let mut v = serde_json::to_value(hello()).unwrap();
        v["future"] = json!(1);
        assert_eq!(serde_json::from_value::<Hello>(v).unwrap(), hello());
    }

    #[test]
    fn events_commands_and_answers_on_the_wire() {
        assert_eq!(
            event(
                name::STATE,
                &StateEvent {
                    state: NodeState::Revoked
                }
            ),
            r#"{"e":"state","p":{"state":"revoked"}}"#
        );
        assert_eq!(
            request(
                7,
                name::COMMAND,
                &CommandParams {
                    command: Command::ClaudeRestart
                }
            ),
            r#"{"id":7,"m":"command","p":{"command":"claude_restart"}}"#
        );
        for (c, w) in [
            (Command::CheckUpdate, "check_update"),
            (Command::ClaudeUpdate, "claude_update"),
        ] {
            assert_eq!(wire(&c), format!("\"{w}\""));
        }
        assert_eq!(
            wire(&Response::ok(7, &Accepted { accepted: true })),
            r#"{"id":7,"ok":{"accepted":true}}"#
        );
        assert_eq!(
            HB_LINE,
            event(name::HB, &json!(null)).replace(r#","p":null"#, "")
        );
        let session = ClaudeSessionParams {
            action: SessionAction::Resume,
            id: "abdda3a9-0cb2-43f1-b13e-37f25a755fce".into(),
            request: "00112233445566ff".into(),
        };
        assert_eq!(
            request(8, name::CLAUDE_SESSION, &session),
            concat!(
                r#"{"id":8,"m":"claude_session","p":{"action":"resume","#,
                r#""id":"abdda3a9-0cb2-43f1-b13e-37f25a755fce","request":"00112233445566ff"}}"#
            )
        );
        for bad in [
            json!({"action":"resume","id":"x","request":"r","flags":["--dangerously-skip-permissions"]}),
            json!({"action":"attach","id":"x","request":"r"}),
            json!({"action":"stop","id":"x"}),
        ] {
            assert!(
                serde_json::from_value::<ClaudeSessionParams>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        let load = crate::node::providers::ProviderModelParams {
            kind: crate::node::providers::ProviderKind::Lemonade,
            action: crate::node::providers::ModelAction::Load,
            model: "Gemma-4".into(),
            pinned: true,
            replacing: Some("Qwen3".into()),
            request: "00112233445566ff".into(),
        };
        assert_eq!(
            request(9, name::PROVIDER_MODEL, &load),
            concat!(
                r#"{"id":9,"m":"provider_model","p":{"kind":"lemonade","action":"load","#,
                r#""model":"Gemma-4","pinned":true,"replacing":"Qwen3","request":"00112233445566ff"}}"#
            )
        );
        assert!(load.check().is_ok());
        for bad in [
            json!({"kind":"lemonade","action":"load","model":"m","request":"00112233445566ff","url":"http://x"}),
            json!({"kind":"lemonade","action":"delete","model":"m","request":"00112233445566ff"}),
        ] {
            assert!(
                serde_json::from_value::<crate::node::providers::ProviderModelParams>(bad.clone())
                    .is_err(),
                "{bad}"
            );
        }
        for bad in [
            json!({"kind":"ollama","action":"load","model":"m","request":"00112233445566ff"}),
            json!({"kind":"lemonade","action":"load","model":" ","request":"00112233445566ff"}),
            json!({"kind":"lemonade","action":"unload","model":"m","replacing":"n","request":"00112233445566ff"}),
            json!({"kind":"lemonade","action":"load","model":"m","request":"short"}),
        ] {
            let p: crate::node::providers::ProviderModelParams =
                serde_json::from_value(bad.clone()).unwrap();
            assert!(p.check().is_err(), "{bad}");
        }
        let roster = Roster {
            reported_at: "t".into(),
            ..Default::default()
        };
        assert_eq!(
            event(name::CLAUDE_ROSTER, &Some(roster)),
            concat!(
                r#"{"e":"claude_roster","p":{"reported_at":"t","agents_available":false,"agents":[],"#,
                r#""transcripts":[],"transcript_total":0,"empty_count":0,"truncated":false,"managed":[],"#,
                r#""session_stats":[],"server":null,"actions":[],"errors":[]}}"#
            )
        );
        assert!(serde_json::from_value::<CommandParams>(json!({"command":"reboot"})).is_err());
        assert!(
            serde_json::from_value::<CommandParams>(json!({"command":"check_update","x":1}))
                .is_err()
        );
    }

    #[test]
    fn a_policy_request_on_the_wire_names_settings_and_never_grants_santree() {
        let off = PolicyRequest {
            awake_hold: Some(false),
            ..Default::default()
        };
        assert_eq!(
            request(3, name::POLICY_REQUEST, &off),
            r#"{"id":3,"m":"policy_request","p":{"awake_hold":false}}"#
        );
        let all = PolicyRequest {
            awake_hold: Some(true),
            claude_remote_control: Some(false),
            santree: Some(false),
        };
        assert_eq!(
            wire(&all),
            r#"{"awake_hold":true,"claude_remote_control":false,"santree":false}"#
        );
        assert!(off.check().is_ok() && all.check().is_ok());
        // Nothing asked, santree granted: refused.
        assert!(PolicyRequest::default().check().is_err());
        let grant = PolicyRequest {
            santree: Some(true),
            ..Default::default()
        };
        assert!(grant.check().unwrap_err().contains("from Daedalus"));
        // Exact: a key the machine may not ask for does not parse.
        for bad in [
            json!({"awake_hold": false, "providers": {}}),
            json!({"name": "evil"}),
            json!({"santree": "yes"}),
        ] {
            assert!(
                serde_json::from_value::<PolicyRequest>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_rotation_on_the_wire() {
        let p = RotateParams {
            new_public_key: "ab".repeat(32),
            signature: "cd".repeat(64),
        };
        assert_eq!(
            request(10, name::ROTATE, &p),
            format!(
                r#"{{"id":10,"m":"rotate","p":{{"new_public_key":"{}","signature":"{}"}}}}"#,
                "ab".repeat(32),
                "cd".repeat(64)
            )
        );
        // Exact: nothing else rides it.
        assert!(serde_json::from_value::<RotateParams>(
            json!({"new_public_key":"x","signature":"y","grace":1})
        )
        .is_err());
        assert!(serde_json::from_value::<RotateParams>(json!({"new_public_key":"x"})).is_err());
    }
    #[test]
    fn santree_rides_the_policy_and_either_side_may_be_older() {
        let host = SessionHost {
            address: "box.example.org:7789".into(),
            public_key: "ab".repeat(32),
        };
        let on = Policy {
            santree: true,
            session_host: Some(host.clone()),
            ..Policy::default()
        };
        assert_eq!(
            event(name::POLICY, &on),
            format!(
                r#"{{"e":"policy","p":{{"awake_hold":true,"claude_remote_control":true,"santree":true,"session_host":{{"address":"box.example.org:7789","public_key":"{}"}}}}}}"#,
                "ab".repeat(32)
            )
        );
        // Off is absent: what a 0.21 controller sent, and a 0.21 kept
        // policy.json, parse to santree off.
        assert_eq!(
            wire(&Policy::default()),
            r#"{"awake_hold":true,"claude_remote_control":true}"#
        );
        let old: Policy =
            serde_json::from_str(r#"{"awake_hold":false,"claude_remote_control":true}"#).unwrap();
        assert!(!old.santree && old.session_host.is_none());
        // A 0.21 agent reads a new controller's policy: its Policy had no
        // such fields, and the link ignores what it does not know.
        #[derive(Deserialize)]
        #[allow(dead_code)]
        struct Policy021 {
            awake_hold: bool,
            claude_remote_control: bool,
        }
        let read: Policy021 = serde_json::from_str(&wire(&on)).unwrap();
        assert!(read.awake_hold);
        // A newer controller's further fields are ignored here too.
        let mut v = serde_json::to_value(&on).unwrap();
        v["future"] = json!({"x": 1});
        v["session_host"]["future"] = json!(1);
        assert_eq!(serde_json::from_value::<Policy>(v).unwrap(), on);

        // Checked where it is used; a bad one still parses.
        assert_eq!(
            host.checked().unwrap(),
            ("box.example.org:7789", [0xab; 32])
        );
        for bad in [
            SessionHost {
                address: "box.example.org".into(),
                ..host.clone()
            },
            SessionHost {
                address: format!("{}:7789", "a".repeat(252)),
                ..host.clone()
            },
            SessionHost {
                public_key: "ab".into(),
                ..host.clone()
            },
        ] {
            assert!(bad.checked().is_err(), "{bad:?}");
            let kept = Policy {
                santree: true,
                session_host: Some(bad),
                ..Policy::default()
            };
            assert_eq!(serde_json::from_str::<Policy>(&wire(&kept)).unwrap(), kept);
        }
    }
}
