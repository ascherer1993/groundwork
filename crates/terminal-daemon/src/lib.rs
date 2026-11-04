//! `groundworkd` keeps Groundwork's terminal sessions running between app
//! launches, so shells, and the Claude sessions in them, survive quitting.
//!
//! One daemon per user listens on a Unix socket in Groundwork's data folder.
//! It's started on demand by [`Client::connect_or_start`] and exits once it
//! has no sessions and no clients. See [`protocol`] for the wire format.

pub mod client;
pub mod protocol;
pub mod server;

pub use client::{Client, Error};
