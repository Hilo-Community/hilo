//! Connection-local JSON-RPC IDs and writes for a sandboxed agent transport.
use super::{
    bad, json, send, AcpError, ChildInput, Value, MAX_PENDING_REQUESTS, MAX_SESSION_ITEMS,
};
use std::{
    collections::BTreeMap,
    sync::{
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex, MutexGuard,
    },
    time::Instant,
};

/// A single wire with a connection-wide request counter and routing table.
pub(super) struct Transport {
    input: Arc<Mutex<ChildInput>>,
    outgoing: BTreeMap<u64, PendingRequest>,
    next_id: u64,
    sessions: SessionRoutes,
    elicitations: SessionRoutes,
    inboxes: BTreeMap<String, SyncSender<IncomingPacket>>,
    read_error: Option<String>,
    replay_activity: BTreeMap<String, Instant>,
}

/// One session's access to the wire. Ownership is checked independently of the JSON payload.
pub(super) struct Connection {
    transport: Arc<Mutex<Transport>>,
    owner: String,
    inbox: Receiver<IncomingPacket>,
}

struct PendingRequest {
    method: String,
    session_id: Option<String>,
    owner: String,
}

pub(super) struct IncomingPacket {
    pub kind: SessionPacket,
    pub message: Value,
}

pub(super) enum Incoming {
    Idle,
    Packet(IncomingPacket),
    Closed,
}

pub(super) enum SessionPacket {
    Response,
    Elicitation,
    Notification,
    Request,
    HistoryReplay,
}

#[derive(Default)]
struct SessionRoutes {
    by_id: BTreeMap<String, String>,
}

impl SessionRoutes {
    fn bind(&mut self, session_id: &str, owner: &str) -> Result<(), AcpError> {
        if let Some(existing) = self.by_id.get(session_id) {
            if existing != owner {
                return Err(bad("session id already belongs to another chat"));
            }
        } else {
            self.by_id.insert(session_id.into(), owner.into());
        }
        Ok(())
    }

    fn owner(&self, session_id: &str) -> Option<&str> {
        self.by_id.get(session_id).map(String::as_str)
    }
}

impl Transport {
    pub(super) fn new(input: ChildInput) -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            input: Arc::new(Mutex::new(input)),
            outgoing: BTreeMap::new(),
            next_id: 0,
            sessions: SessionRoutes::default(),
            elicitations: SessionRoutes::default(),
            inboxes: BTreeMap::new(),
            read_error: None,
            replay_activity: BTreeMap::new(),
        }))
    }

    pub(super) fn dispatch(
        &mut self,
        fallback_owner: &str,
        message: Value,
    ) -> Result<(), AcpError> {
        self.bind_session_response(&message)?;
        let (owner, kind) = self
            .recipient(&message)?
            .unwrap_or((fallback_owner, SessionPacket::Notification));
        if matches!(kind, SessionPacket::HistoryReplay) {
            self.replay_activity
                .insert(owner.to_owned(), Instant::now());
            return Ok(());
        }
        let inbox = self
            .inboxes
            .get(owner)
            .ok_or_else(|| bad("agent packet has no attached chat"))?;
        inbox
            .try_send(IncomingPacket { kind, message })
            .map_err(|_| bad("agent chat inbox cannot receive more messages"))
    }

    fn bind_session_response(&mut self, message: &Value) -> Result<(), AcpError> {
        if message.get("method").is_some() || message.get("error").is_some() {
            return Ok(());
        }
        let Some(pending) = message["id"].as_u64().and_then(|id| self.outgoing.get(&id)) else {
            return Ok(());
        };
        let id = match pending.method.as_str() {
            "session/new" => message["result"]["sessionId"].as_str(),
            "session/load" | "session/resume" => pending.session_id.as_deref(),
            _ => return Ok(()),
        }
        .filter(|id| !id.is_empty() && id.len() < 256)
        .ok_or_else(|| bad("invalid session id"))?;
        // The agent may send an update in the next stdout frame, before the worker sees Ready.
        self.sessions.bind(id, &pending.owner)
    }

    pub(super) fn finish_reading(&mut self, error: Option<AcpError>) {
        self.read_error = error.map(|error| match error {
            AcpError::Protocol(message) => message,
            other => other.to_string(),
        });
        self.inboxes.clear();
    }

    fn recipient<'a>(
        &'a self,
        packet: &Value,
    ) -> Result<Option<(&'a str, SessionPacket)>, AcpError> {
        let Some(method) = packet["method"].as_str() else {
            let id = packet["id"]
                .as_u64()
                .ok_or_else(|| bad("unknown response id"))?;
            let pending = self
                .outgoing
                .get(&id)
                .ok_or_else(|| bad("unsolicited response"))?;
            return Ok(Some((&pending.owner, SessionPacket::Response)));
        };
        if method.starts_with('_') || method == "auth/status_update" {
            return Ok(None);
        }
        let params = &packet["params"];
        if method == "elicitation/complete" {
            let owner = params["elicitationId"]
                .as_str()
                .and_then(|id| self.elicitations.owner(id));
            return Ok(owner.map(|owner| (owner, SessionPacket::Notification)));
        }
        let session_id = params["sessionId"].as_str();
        if method == "elicitation/create" && session_id.is_none() {
            let owner = params["requestId"]
                .as_u64()
                .and_then(|id| self.outgoing.get(&id))
                .filter(|pending| pending.method == "authenticate")
                .map(|pending| pending.owner.as_str())
                .ok_or_else(|| bad("elicitation has no active request or session"))?;
            return Ok(Some((owner, SessionPacket::Elicitation)));
        }
        let id = session_id.ok_or_else(|| bad(&format!("missing session for {method}")))?;
        if let Some(owner) = self.sessions.owner(id) {
            let kind = if method == "elicitation/create" {
                SessionPacket::Elicitation
            } else if packet.get("id").is_none() {
                SessionPacket::Notification
            } else {
                SessionPacket::Request
            };
            return Ok(Some((owner, kind)));
        }
        if method == "session/update" && packet.get("id").is_none() {
            if let Some(load) = self.outgoing.values().find(|pending| {
                pending.method == "session/load" && pending.session_id.as_deref() == Some(id)
            }) {
                return Ok(Some((&load.owner, SessionPacket::HistoryReplay)));
            }
        }
        Err(bad(&format!("wrong session for {method}")))
    }
}

impl Connection {
    pub(super) fn attach(transport: Arc<Mutex<Transport>>, owner: &str) -> Result<Self, AcpError> {
        let (sender, inbox) = mpsc::sync_channel(MAX_SESSION_ITEMS);
        {
            let mut shared = transport
                .lock()
                .map_err(|_| bad("agent transport lock poisoned"))?;
            if shared.inboxes.contains_key(owner) {
                return Err(bad("chat is already attached to the agent transport"));
            }
            shared.inboxes.insert(owner.into(), sender);
        }
        Ok(Self {
            transport,
            owner: owner.into(),
            inbox,
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Transport>, AcpError> {
        self.transport
            .lock()
            .map_err(|_| bad("agent transport lock poisoned"))
    }

    pub(super) fn bind_session(&mut self, id: &str) -> Result<(), AcpError> {
        self.lock()?.sessions.bind(id, &self.owner)
    }

    pub(super) fn take_response(&mut self, message: &Value) -> Result<String, AcpError> {
        let id = message["id"]
            .as_u64()
            .ok_or_else(|| bad("unknown response id"))?;
        let mut transport = self.lock()?;
        match transport.outgoing.get(&id) {
            Some(pending) if pending.owner == self.owner => {}
            Some(_) => return Err(bad("response belongs to another chat")),
            None => return Err(bad("unsolicited response")),
        }
        transport
            .outgoing
            .remove(&id)
            .map(|pending| pending.method)
            .ok_or_else(|| bad("unsolicited response"))
    }

    pub(super) fn last_replay_activity(&self) -> Option<Instant> {
        self.lock().ok()?.replay_activity.get(&self.owner).copied()
    }

    pub(super) fn receive(&self, timeout: std::time::Duration) -> Result<Incoming, AcpError> {
        match self.inbox.recv_timeout(timeout) {
            Ok(packet) => Ok(Incoming::Packet(packet)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(Incoming::Idle),
            Err(mpsc::RecvTimeoutError::Disconnected) => match &self.lock()?.read_error {
                Some(error) => Err(bad(error)),
                None => Ok(Incoming::Closed),
            },
        }
    }

    pub(super) fn bind_elicitation(&mut self, id: &str) -> Result<(), AcpError> {
        self.lock()?.elicitations.bind(id, &self.owner)
    }

    pub(super) fn forget_elicitation(&mut self, id: &str) {
        if let Ok(mut transport) = self.lock() {
            if transport.elicitations.owner(id) == Some(&self.owner) {
                transport.elicitations.by_id.remove(id);
            }
        }
    }

    fn write(&self, wire: &Value) -> Result<(), AcpError> {
        let input = self.lock()?.input.clone();
        let mut input = input
            .lock()
            .map_err(|_| bad("agent writer lock poisoned"))?;
        send(&mut *input, wire)
    }

    pub(super) fn notify(&mut self, method: &str, params: Value) -> Result<(), AcpError> {
        self.write(&json!({"jsonrpc":"2.0","method":method,"params":params}))
    }

    pub(super) fn request(&mut self, method: &str, params: Value) -> Result<(), AcpError> {
        let id = {
            let mut transport = self.lock()?;
            if transport.outgoing.len() >= MAX_PENDING_REQUESTS {
                return Err(bad("outgoing request limit"));
            }
            let id = transport.next_id;
            transport.next_id += 1;
            transport.outgoing.insert(
                id,
                PendingRequest {
                    method: method.into(),
                    owner: self.owner.clone(),
                    session_id: params["sessionId"].as_str().map(str::to_owned),
                },
            );
            id
        };
        let result = self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        if result.is_err() {
            self.lock()?.outgoing.remove(&id);
        }
        result
    }
    pub(super) fn reply(
        &mut self,
        request: &Value,
        result: Result<Value, String>,
    ) -> Result<(), AcpError> {
        let value = match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
            Err(reason) => {
                json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":reason}})
            }
        };
        self.write(&value)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Ok(mut transport) = self.lock() {
            transport
                .sessions
                .by_id
                .retain(|_, owner| owner != &self.owner);
            transport
                .elicitations
                .by_id
                .retain(|_, owner| owner != &self.owner);
            transport
                .outgoing
                .retain(|_, request| request.owner != self.owner);
            transport.inboxes.remove(&self.owner);
            transport.replay_activity.remove(&self.owner);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn next(connection: &Connection) -> Option<IncomingPacket> {
        match connection.receive(Duration::ZERO).unwrap() {
            Incoming::Packet(packet) => Some(packet),
            Incoming::Idle | Incoming::Closed => None,
        }
    }

    #[test]
    fn a_session_update_is_routed_before_its_worker_has_processed_ready() {
        let transport = Transport::new(Box::new(std::io::sink()));
        let mut session = Connection::attach(transport.clone(), "thread").unwrap();
        session
            .request("session/new", json!({"cwd":"/workspace"}))
            .unwrap();
        let mut wire = transport.lock().unwrap();
        wire.dispatch("thread", json!({"id":0,"result":{"sessionId":"created"}}))
            .unwrap();
        wire.dispatch(
            "thread",
            json!({"method":"session/update","params":{"sessionId":"created"}}),
        )
        .unwrap();
        drop(wire);

        assert!(matches!(
            next(&session).unwrap().kind,
            SessionPacket::Response
        ));
        assert!(matches!(
            next(&session).unwrap().kind,
            SessionPacket::Notification
        ));
    }

    #[test]
    fn detaching_a_session_releases_only_its_routes() {
        let transport = Transport::new(Box::new(std::io::sink()));
        let mut a = Connection::attach(transport.clone(), "thread-a").unwrap();
        let mut b = Connection::attach(transport.clone(), "thread-b").unwrap();
        a.bind_session("session-a").unwrap();
        b.bind_session("session-b").unwrap();
        a.request("session/prompt", json!({"sessionId":"session-a"}))
            .unwrap();
        b.request("session/prompt", json!({"sessionId":"session-b"}))
            .unwrap();
        drop(b);

        assert_eq!(a.take_response(&json!({"id":0})).unwrap(), "session/prompt");
        assert!(transport
            .lock()
            .unwrap()
            .dispatch("thread-a", json!({"id":1,"result":{}}))
            .is_err());
        let mut restored = Connection::attach(transport, "thread-b-reopened").unwrap();
        restored.bind_session("session-b").unwrap();
        assert!(restored.bind_session("session-a").is_err());
    }

    #[test]
    fn one_wire_keeps_interleaved_response_and_permission_routes_separate() {
        let transport = Transport::new(Box::new(std::io::sink()));
        let mut a = Connection::attach(transport.clone(), "thread-a").unwrap();
        let mut b = Connection::attach(transport.clone(), "thread-b").unwrap();
        a.bind_session("session-a").unwrap();
        b.bind_session("session-b").unwrap();
        assert!(b.bind_session("session-a").is_err());

        a.request("session/prompt", json!({"sessionId":"session-a"}))
            .unwrap();
        b.request("session/prompt", json!({"sessionId":"session-b"}))
            .unwrap();
        let second = json!({"id":1,"result":{}});
        transport
            .lock()
            .unwrap()
            .dispatch("thread-a", second)
            .unwrap();
        transport
            .lock()
            .unwrap()
            .dispatch("thread-b", json!({"id":0,"result":{}}))
            .unwrap();
        let a_reply = next(&a).unwrap();
        let b_reply = next(&b).unwrap();
        assert_eq!(a_reply.message["id"], 0);
        assert_eq!(b_reply.message["id"], 1);
        assert!(a.take_response(&b_reply.message).is_err());
        assert_eq!(a.take_response(&a_reply.message).unwrap(), "session/prompt");
        assert_eq!(b.take_response(&b_reply.message).unwrap(), "session/prompt");

        let permission = json!({"id":7,"method":"session/request_permission","params":{"sessionId":"session-b"}});
        transport
            .lock()
            .unwrap()
            .dispatch("thread-a", permission)
            .unwrap();
        assert!(next(&a).is_none());
        assert!(matches!(next(&b).unwrap().kind, SessionPacket::Request));
        b.bind_elicitation("signin-b").unwrap();
        transport
            .lock()
            .unwrap()
            .dispatch(
                "thread-a",
                json!({"method":"elicitation/complete","params":{"elicitationId":"signin-b"}}),
            )
            .unwrap();
        assert!(next(&a).is_none());
        assert!(matches!(
            next(&b).unwrap().kind,
            SessionPacket::Notification
        ));
    }
}
