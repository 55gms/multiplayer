# What a 1v1.lol match sends

Recorded with two headless players on this server (`MP_DEBUG=1`, RPC arguments
logged in full), one firing at the other until it died. The RPC names come
from the build's `PhotonServerSettings` RPC list (PUN sends the index, as
event 200 parameter 5) and the method signatures from its IL2CPP metadata.

## Room properties (SetProperties by the master client)

| Property                             | When                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| `curScn`                             | scene: `MainMenu`, then the map (`NormalMap`)                  |
| `gameStarted: true`, `gameStartTime` | the match starts                                               |
| `gameOver: true`                     | the match is over; sent again every second until players leave |

The master client is a player, so these are claims, not facts.

## RPCs that matter (event 200)

| Index | RPC                        | Sent by                                                                         | Arguments                                                           |
| ----- | -------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 7     | `PlayerController.TakeHit` | the shooter, on the victim's player view (`viewID / 1000` = the victim's actor) | `[weaponType, damagerPos (Vector3), shotsCounter, headShotCounter]` |
| 24    | `GameManager.PlayerDied`   | **the player who died**, on scene view 1                                        | `[deadActorNr, killerActorNr]`                                      |
| 32    | `ChangeSkinsRPC`           | each player at spawn                                                            |                                                                     |

Others seen in a match: 17 `ShotOccured`, 15 `FinishedAiming`, 19
`StartedReload`, 20 `CancelReloadAnimation`, 34 `CreateBuildingRemote`, 35
`DestroyBuildingRemote`, 36 `HitBuildingRemote`, 16 `ChangeStateRemote`.

The full list, by index: 0 ActivateBuilding, 1 BuildingStatusUpdate, 2
ClickRpc, 3 DestroyRpc, 4 DestroySpaceship, 5 Fire, 6 RespawnSpaceship, 7
TakeHit, 8 ShapeStateChanged, 9 ChangeDoorRotation, 10 Shoot, 11 SwitchWeapon,
12 UnequipWeapon, 13 StartedZooming, 14 StartedAiming, 15 FinishedAiming, 16
ChangeStateRemote, 17 ShotOccured, 18 CancelReloadRemote, 19 StartedReload, 20
CancelReloadAnimation, 21 PlayerReady, 22 UpdateUsersList, 23 PlayerKilled, 24
PlayerDied, 25 ShowDamage, 26 StartHit, 27 UpdateCrouch, 28 FinishHit, 29
HittedSomething, 30 ChangeColorRPC, 31 KickPlayer, 32 ChangeSkinsRPC, 33
HitAir, 34 CreateBuildingRemote, 35 DestroyBuildingRemote, 36
HitBuildingRemote, 37 ShapeStateChangedRemote, 38 BuildingShapeChangedRemote,
39 ExecuteGenericRemote, 40 ChangeWeaponSkinsRPC, 41 Emote, 42
PartyStartGameMultiplayer, 43 PartyStartGamePrivate, 44 UpdatePartyMembersUI,
45 KillAllBuildingsRemote, 46 PlayEmoteInGame, 47 StopEmoteInGame, 48
UpdateAllPartyUI.

## How a 1v1 ends

1v1 is one life each. In the recording the shooter (actor 1) sent seven
`TakeHit` on actor 2's player; actor 2's own client then sent
`PlayerDied [2, 1]`, and within a second the master client set `gameOver`.
With nobody dead, the round runs out after three minutes ("Time's Up!") and
nobody wins.

So the result can be read from two streams that have to agree:

- the dead player's own `PlayerDied` naming itself as dead (one player cannot
  make another's client say it died), and
- the killer's `TakeHit` RPCs on the dead player's view before it.

A player who leaves before `gameOver` has left a match in progress.

In competitive modes the game also sets a room property
`USERID_<Photon user id>` to the 55GMS account uuid for each player, and its
ranked search filter is `<rating> >= C1 AND <rating> <= C2` with the room's
range in `C1`/`C2` (see `master.js`: the server does not use it).

## Modes

| Mode                                                                                                            | Readable                                                                                                     | Winner                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1v1`                                                                                                           | yes, recorded                                                                                                | the player not named dead in a `PlayerDied` from the dead player's own stream, backed by that player's `TakeHit`s from the killer; time out = no winner |
| `1v1_Competitive` | yes: a live ranked match sent the same room properties (`gameStarted`, `gameOver`) and RPCs; its kill path was checked by replaying the recorded `1v1` messages | as `1v1` |
| `Teams_2v2_Competitive`, `BoxFight_Teams_2v2`, `Teams_City_ZoneWars`, `PipeRun_Race`, custom and practice modes | not recorded (four headless players are too slow on this machine); rounds, respawns and team scoring unknown | treated as unreadable: no XP, stats, rating or battle pass progress, and `Teams_2v2_Competitive` is left out of the competitive list                    |
