//! How the parts talk: the one envelope (rpc.rs), framed as lines
//! (jsonl.rs) within deadlines that do not move (deadline.rs).

pub mod deadline;
pub mod jsonl;
pub mod rpc;

/// The longest line any door reads or writes: the link, and the agent's
/// local socket and API.
pub const MAX_LINE: usize = 1 << 20;
