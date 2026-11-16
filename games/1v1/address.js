// Where a client should connect for a role, on the host it came in on.
export function address(peer, role) {
  return `${peer.scheme}://${peer.host}/api/mp/1v1/${role}`;
}
