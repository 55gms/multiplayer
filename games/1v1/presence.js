// Who is online and in which room, by user id, for FindFriends (parties
// find their leader's room this way).
const online = new Map(); // userId -> Set<peer>
const rooms = new Map(); // userId -> room name

export function connected(peer) {
  const userId = peer.state.userId;
  if (!userId) return;
  let set = online.get(userId);
  if (!set) online.set(userId, (set = new Set()));
  set.add(peer);
  peer.once("close", () => {
    set.delete(peer);
    if (set.size === 0 && online.get(userId) === set) online.delete(userId);
  });
}

export function enteredRoom(userId, roomName) {
  if (userId) rooms.set(userId, roomName);
}

export function leftRoom(userId, roomName) {
  if (userId && rooms.get(userId) === roomName) rooms.delete(userId);
}

export function isOnline(userId) {
  return online.has(userId);
}

export function roomOf(userId) {
  return rooms.get(userId) || "";
}

export function onlineCount() {
  return online.size;
}
