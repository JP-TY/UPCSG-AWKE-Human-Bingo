# Requirements Document

## Introduction

Human Bingo is a responsive web application that lets a host create a task-based social bingo, invite participants, and coordinate verified progress through synchronized 5x5 bingo grids. The web application is usable on mobile phones, tablets, and desktop browsers. Each participant receives a randomized grid based on the host's task bag. A participant completes a square by identifying another participant who fulfills the task; the identified participant must confirm the completion before the square contributes to progress or leaderboard results.

The feature is intended to make in-person or group activities easy to organize while preserving participant agency, preventing self-verification, and giving every hosted Human Bingo a shared view of competitive progress.

## Glossary

- **Responsive_Web_App**: The browser-based Human Bingo interface that adapts its layout and controls for mobile phone, tablet, and desktop browser viewport widths.
- **Responsive_Layout**: A Responsive_Web_App layout that keeps the primary game view usable across supported viewport widths without horizontal scrolling.
- **Browser_Client**: A browser session running the Responsive_Web_App on a mobile phone, tablet, or desktop computer.
- **Authoritative_Web_Backend**: The shared server-side service that persists Hosted_Human_Bingo state and coordinates synchronized updates for Browser_Clients.
- **Browser_Notification**: A notification delivered through a browser's supported web-notification capability after the Participant grants permission.
- **Resumable_Browser_Access**: Authenticated or otherwise user-authorized access that lets a Participant return to an existing Hosted_Human_Bingo from a browser session and restore the Participant's records from the Authoritative_Web_Backend.
- **Human_Bingo_System**: The Responsive_Web_App and its Authoritative_Web_Backend that manage hosted Human Bingos, participants, grids, verification, notifications, and leaderboards across Browser_Clients.
- **Host**: The participant who creates and manages a hosted Human Bingo.
- **Hosted_Human_Bingo**: One host-created game instance with its own task bag, participants, grids, verification records, notifications, and leaderboards.
- **Task_Bag**: The host-provided collection of task entries used as the source for participant grids.
- **Task_Entry**: One task in a Task_Bag, consisting of task text.
- **Join_Code**: A generated code that identifies a Hosted_Human_Bingo and can be entered during onboarding.
- **Invitation_Link**: A shareable link containing or resolving to a Join_Code.
- **Invitation_QR_Code**: A QR representation of an Invitation_Link.
- **Player_Profile**: The web-application participant record created or resumed during onboarding.
- **Player_Code**: The generated code associated with a Player_Profile in a Hosted_Human_Bingo and used to identify a participant during verification.
- **Participant**: A Player_Profile that has successfully joined a Hosted_Human_Bingo.
- **Grid**: A persisted 5x5 arrangement of 25 Task_Entries assigned to one Participant.
- **Square**: One of the 25 positions in a Grid.
- **Verification_Request**: A request from a Participant asking another Participant to confirm that the other Participant fulfills a Square's Task_Entry.
- **Verified_Square**: A Square whose Verification_Request has been confirmed by the identified Participant.
- **Blackout**: Completion of all 25 Squares in one Participant's Grid.
- **Line**: Any one of the 5 horizontal rows, 5 vertical columns, or 2 diagonals in a Grid.
- **Hashtag**: The fixed 5x5 board pattern consisting of every Square in rows 2 and 4 and columns 2 and 4, using 1-based row and column numbering; the four row-column intersections are shared, so the pattern contains 16 distinct Squares.
- **Hashtag_Completion**: A completion recorded when all 16 distinct Squares in the fixed Hashtag pattern of a Participant's Grid are Verified_Squares; Hashtag_Completion is not based on Task_Entry text, labels, metadata, or other task groupings.
- **Leaderboard**: An ordered, synchronized ranking for one completion category within a Hosted_Human_Bingo.
- **Draft_Status**: The lifecycle status in which a Hosted_Human_Bingo can be configured but cannot admit Participants.
- **Invitation_Available_Status**: The lifecycle status in which a Hosted_Human_Bingo has a valid Join_Code and can admit Participants.
- **Active_Game**: The lifecycle status in which a Hosted_Human_Bingo accepts verification activity and records leaderboard progress.
- **Closed_Game**: The lifecycle status in which a Hosted_Human_Bingo no longer accepts new Participants or verification activity.
- **Unverified_Status**: The Square state in which no confirmed Verification_Request exists.
- **Pending_Status**: The Square state in which a Verification_Request awaits the identified Participant's response.
- **Rejected_Status**: The recorded outcome state after an identified Participant rejects a Verification_Request; the Square can receive a later request.

## Assumptions and Scope Decisions

1. The feature targets Browser_Clients in mobile phone, tablet, and desktop browsers and requires an Authoritative_Web_Backend to synchronize state; the requirements do not prescribe a specific implementation technology.
2. Every Grid contains 25 task squares. The center square is a normal Task_Entry and is not a free square.
3. A Host may save an incomplete Draft_Status, but the Human_Bingo_System may open an invitation only after the Task_Bag contains at least 25 distinct Task_Entries. Distinctness is determined after trimming task text and applying case-insensitive comparison.
4. The Hashtag is the same fixed pattern in every Participant's Grid: every Square in row 2, row 4, column 2, and column 4 using 1-based row and column numbering. The four intersections are shared, so the Hashtag contains exactly 16 distinct Squares. A Hashtag_Completion requires all 16 of those Squares to be Verified_Squares and is not based on Task_Entry text, labels, metadata, or arbitrary task groupings.
5. The Human_Bingo_System samples Task_Entries without replacement within a Grid. The same Task_Entry may appear in different Participants' Grids, so participants can have different randomized grids while using the same Task_Bag.
6. The Human_Bingo_System locks the Task_Bag when the Hosted_Human_Bingo first admits a Participant. The fixed Hashtag pattern is not configurable and does not depend on Task_Entry metadata or the locked Task_Bag contents. Later task changes are outside this feature's scope and cannot alter persisted Grids.
7. On first successful join to a Hosted_Human_Bingo, the Human_Bingo_System creates a Player_Profile and generates a Player_Code. The Player_Code is unique within the Hosted_Human_Bingo and remains associated with the Participant for that game; a returning Participant resumes the existing Player_Profile rather than receiving a second code.
8. An Invitation_Link and Invitation_QR_Code resolve to the same Join_Code. The Host may share either representation through normal browser and link-sharing mechanisms.
9. A Host is not automatically a Participant. A Host who wants a Grid joins through the same invitation and onboarding flow as other Participants.
10. Browser-notification permission, browser support, and network connectivity can vary. In-app pending requests and synchronized Authoritative_Web_Backend state remain the source of truth when Browser_Notification delivery is unavailable.
11. Leaderboard ordering uses the number of qualifying completions in descending order, followed by the earliest timestamp at which the tied completion was recorded, followed by ascending Player_Code as a deterministic tie-breaker.

## Requirements

### Requirement 1: Create and Configure a Hosted Human Bingo

**User Story:** As a Host, I want to configure a task bag for a Human Bingo, so that participants receive grids based on activities I define.

#### Acceptance Criteria

1. WHEN a Host starts a new Hosted_Human_Bingo, THE Human_Bingo_System SHALL create exactly one Hosted_Human_Bingo in Draft_Status, assign it a unique game identifier, and provide a name that the Host can save and edit while the Hosted_Human_Bingo remains in Draft_Status.
2. WHEN a Host adds or edits a Task_Entry and saves the change, THE Human_Bingo_System SHALL remove leading and trailing whitespace from the task text before storing it.
3. WHEN a Host saves a Task_Entry whose trimmed task text is empty or consists only of whitespace, THE Human_Bingo_System SHALL reject the save, display an error indication that task text is required, and leave the Task_Bag unchanged.
4. WHEN a Host saves a new or edited Task_Entry whose trimmed task text matches the trimmed task text of a different existing Task_Entry without case sensitivity, THE Human_Bingo_System SHALL reject the save, display an error indication that the task is a duplicate, and leave the Task_Bag unchanged.
5. WHILE a Hosted_Human_Bingo is in Draft_Status, THE Human_Bingo_System SHALL allow its Host to add, edit, and remove Task_Entries, and SHALL apply each accepted change only when the resulting Task_Bag satisfies the non-empty and non-duplicate task-text rules.
6. WHEN a Host attempts to open a Hosted_Human_Bingo containing fewer than 25 distinct Task_Entries, where distinctness is determined by trimmed task text without case sensitivity, THE Human_Bingo_System SHALL keep the Hosted_Human_Bingo in Draft_Status, SHALL not generate or expose a Join_Code, and SHALL display an indication that at least 25 distinct Task_Entries are required.
7. WHEN a Host opens a Hosted_Human_Bingo containing at least 25 distinct Task_Entries, where distinctness is determined by trimmed task text without case sensitivity, THE Human_Bingo_System SHALL generate exactly one Join_Code for that Hosted_Human_Bingo, SHALL set its status to Invitation_Available_Status, and SHALL retain that same Join_Code on every subsequent open attempt before the first Participant joins.
8. WHEN the first Participant successfully joins a Hosted_Human_Bingo, THE Human_Bingo_System SHALL lock that Hosted_Human_Bingo's Task_Bag, preserve its contents for every subsequently generated Participant Grid, and retain the fixed Hashtag pattern as the completion pattern for every Participant.
9. IF a Host attempts to add, edit, or remove a Task_Entry after the Task_Bag is locked, THEN THE Human_Bingo_System SHALL reject the entire modification, preserve the locked Task_Bag contents and Hosted_Human_Bingo status, and display an indication that the change requires a new Hosted_Human_Bingo.

### Requirement 2: Invite Participants Through Link, QR Code, or Code

**User Story:** As a Host, I want multiple invitation formats, so that participants can join conveniently from a browser on any screen size.

#### Acceptance Criteria

1. WHEN a Hosted_Human_Bingo enters Invitation_Available_Status, THE Human_Bingo_System SHALL display one Join_Code to the Host, and that Join_Code SHALL contain exactly 6 characters, with every character being an uppercase letter from A–Z or a digit from 0–9.
2. WHEN a Host requests an Invitation_Link for a Hosted_Human_Bingo in Invitation_Available_Status or Active_Game, THE Human_Bingo_System SHALL provide a shareable Invitation_Link that opens the Responsive_Web_App and resolves to the same Hosted_Human_Bingo identified by its Join_Code; the Invitation_Link SHALL remain usable while the Hosted_Human_Bingo accepts Participants and SHALL become unusable when the Hosted_Human_Bingo is closed, the invitation is revoked, or the invitation expires.
3. WHEN a Host requests an Invitation_QR_Code for a Hosted_Human_Bingo in Invitation_Available_Status or Active_Game, THE Human_Bingo_System SHALL provide a QR representation that a phone camera or QR-capable browser flow can scan and decode into the corresponding Invitation_Link, and that Invitation_Link SHALL open the Responsive_Web_App and resolve to the same Hosted_Human_Bingo identified by its Join_Code.
4. WHEN a Participant submits a Join_Code containing exactly 6 uppercase letters or digits that matches the Join_Code of a Hosted_Human_Bingo in Invitation_Available_Status or Active_Game, THE Human_Bingo_System SHALL open that Hosted_Human_Bingo's onboarding flow in the Responsive_Web_App and SHALL not create or modify a Participant record before onboarding is completed.
5. WHEN a Participant scans an Invitation_QR_Code with a phone camera or QR-capable browser flow, or opens an Invitation_Link, and the invitation resolves to a Hosted_Human_Bingo in Invitation_Available_Status or Active_Game, THE Human_Bingo_System SHALL open that Hosted_Human_Bingo's onboarding flow in the Responsive_Web_App and SHALL not create or modify a Participant record before onboarding is completed.
6. IF a Participant submits a Join_Code that is not exactly 6 uppercase letters or digits, or submits a Join_Code, Invitation_Link, or Invitation_QR_Code that cannot be decoded to a valid Join_Code, does not match an existing Hosted_Human_Bingo, has expired, or has been revoked, THEN THE Human_Bingo_System SHALL display an error indication that identifies the invitation as invalid and SHALL not create or modify a Participant record.
7. IF a Participant uses a Join_Code, Invitation_Link, or Invitation_QR_Code that resolves to a Hosted_Human_Bingo in Closed_Game, THEN THE Human_Bingo_System SHALL display an error indication that the Hosted_Human_Bingo is no longer accepting Participants, SHALL leave onboarding incomplete, and SHALL not create or modify a Participant record.
8. WHEN a Host closes a Hosted_Human_Bingo, THE Human_Bingo_System SHALL reject all subsequent join attempts for that Hosted_Human_Bingo, SHALL preserve every Participant record and completed result that existed at closure, and SHALL make each previously issued Join_Code, Invitation_Link, and Invitation_QR_Code unusable for joining.

### Requirement 3: Onboard Participants and Generate Player Codes

**User Story:** As an invited player, I want a simple generated identity for a hosted game, so that another player can identify me for verification without requiring a separate account setup flow.

#### Acceptance Criteria

1. WHEN a Participant completes the onboarding flow for a Hosted_Human_Bingo that is not in Closed_Game and no Player_Profile exists for that Participant in that Hosted_Human_Bingo, THE Human_Bingo_System SHALL create exactly one Player_Profile associated with that Hosted_Human_Bingo and SHALL associate the Player_Profile with exactly one Participant record for that Hosted_Human_Bingo.
2. WHEN the Human_Bingo_System creates a Player_Profile for a Hosted_Human_Bingo, THE Human_Bingo_System SHALL generate a non-empty Player_Code that is unique within that Hosted_Human_Bingo, SHALL associate the Player_Code with the created Player_Profile, and SHALL retain that association for the lifetime of the Participant's Hosted_Human_Bingo membership.
3. WHEN a Player_Profile and its Player_Code have been created successfully, THE Human_Bingo_System SHALL display the Player_Code and an instruction that the Participant may share the Player_Code with other Participants, and SHALL make the onboarding result available through Resumable_Browser_Access.
4. WHEN a Participant uses Resumable_Browser_Access to resume a Hosted_Human_Bingo for which that Participant already has a Player_Profile, THE Human_Bingo_System SHALL restore and display the existing Player_Profile, its existing Player_Code, and its persisted Grid, including the current state of every Square, and SHALL not create another Participant record, Player_Profile, Player_Code, or Grid for that Participant in that Hosted_Human_Bingo.
5. WHEN onboarding is completed successfully for a Hosted_Human_Bingo with at least one Participant and the Host has not closed the Hosted_Human_Bingo, THE Human_Bingo_System SHALL set the Hosted_Human_Bingo state to Active_Game.
6. IF a Participant attempts to join a Hosted_Human_Bingo in Closed_Game, THEN THE Human_Bingo_System SHALL display the closed-game state, SHALL leave onboarding incomplete, and SHALL not create or modify a Participant record, Player_Profile, Player_Code, or Grid for that Hosted_Human_Bingo.
7. IF the Human_Bingo_System cannot generate a Player_Code that is unique within the Hosted_Human_Bingo, THEN THE Human_Bingo_System SHALL display an error indication that code generation failed, SHALL provide a user-initiated retry action, SHALL leave onboarding incomplete, and SHALL not create or retain a duplicate or partially created Player_Profile, Participant record, Player_Code, or Grid.

### Requirement 4: Generate and Persist Randomized 5x5 Grids

**User Story:** As a Participant, I want a randomized grid of host-defined tasks, so that every player can explore the activity in a varied order.

#### Acceptance Criteria

1. WHEN a Participant successfully joins a Hosted_Human_Bingo, THE Human_Bingo_System SHALL generate and persist exactly one complete Grid for that Participant and Hosted_Human_Bingo, containing exactly 25 Squares arranged in 5 rows and 5 columns.
2. WHEN THE Human_Bingo_System generates a Grid, THE Human_Bingo_System SHALL select exactly 25 distinct Task_Entries from the locked Task_Bag and SHALL assign exactly one selected Task_Entry to each Square.
3. WHEN the Human_Bingo_System generates a Grid, THE Human_Bingo_System SHALL assign no Task_Entry more than once within that Grid, and reading the Squares from left to right and top to bottom SHALL produce a permutation of the 25 selected Task_Entries.
4. WHEN two or more Participants successfully join the same Hosted_Human_Bingo, THE Human_Bingo_System SHALL generate each Participant's Grid from the locked Task_Bag independently of the other Participants' Grid arrangements; identical Grid arrangements MAY occur by chance.
5. WHEN a returning Participant opens a Hosted_Human_Bingo with a persisted Grid, THE Human_Bingo_System SHALL display the same 25 Task_Entries in the same row and column positions and SHALL display the current persisted status of every Square.
6. WHEN the Human_Bingo_System generates a Grid, THE Human_Bingo_System SHALL place the selected Task_Entries in an arrangement that is not assigned sequentially according to their order in the locked Task_Bag.
7. IF Grid generation or complete Grid persistence fails before the Grid is available, THEN THE Human_Bingo_System SHALL report that onboarding is incomplete, SHALL not expose the Grid as playable, and SHALL not retain or expose any partially persisted Grid.
8. IF the locked Task_Bag contains fewer than 25 distinct Task_Entries when Grid generation is attempted, THEN THE Human_Bingo_System SHALL prevent Grid generation and persistence, SHALL report a Task_Bag validation failure, and SHALL not expose a playable Grid.

### Requirement 5: Mark Squares Through Participant Verification

**User Story:** As a Participant, I want another player to confirm each task completion, so that bingo progress reflects verified social interactions rather than unconfirmed claims.

#### Acceptance Criteria

1. WHEN a Participant using a Browser_Client selects a Square in that Participant's Grid whose status is Unverified_Status and submits a Player_Code that identifies another Participant in the same Hosted_Human_Bingo, THE Human_Bingo_System SHALL create exactly one Verification_Request associated with the selected Square, requesting Participant, and identified Participant, and SHALL set the Square's status to Pending_Status.
2. WHEN a Participant submits a Player_Code that is empty, malformed, does not identify a Participant in the current Hosted_Human_Bingo, or identifies a Participant from another Hosted_Human_Bingo, THE Human_Bingo_System SHALL reject the Verification_Request attempt, SHALL display an error indication that the Player_Code is invalid for the current Hosted_Human_Bingo, and SHALL leave the selected Square's status and existing Verification_Request records unchanged.
3. WHEN a Participant submits that Participant's own Player_Code for a Square, THE Human_Bingo_System SHALL reject the Verification_Request attempt, SHALL display an error indication that self-verification is not allowed, and SHALL leave the selected Square's status and existing Verification_Request records unchanged.
4. WHEN a Verification_Request is created for a Square in Unverified_Status, THE Human_Bingo_System SHALL set that Square's status to Pending_Status and SHALL retain the Pending_Status until the request is confirmed or rejected.
5. WHEN a Participant submits a Verification_Request for a Square that already has a pending Verification_Request, THE Human_Bingo_System SHALL retain the existing pending request, SHALL not create another Verification_Request for that Square, and SHALL leave the Square in Pending_Status.
6. WHEN the identified Participant confirms a pending Verification_Request using a Browser_Client, THE Human_Bingo_System SHALL set the associated Square's status to Verified_Square, SHALL record the confirmation time and confirmation outcome, and SHALL make the resulting status and outcome available to the requesting and identified Participants.
7. WHEN the identified Participant rejects a pending Verification_Request using a Browser_Client, THE Human_Bingo_System SHALL set the associated Square's status to Unverified_Status, SHALL record the rejection time and rejection outcome, and SHALL make the resulting status and outcome available to the requesting and identified Participants.
8. WHILE a Verification_Request is pending, THE Human_Bingo_System SHALL display Pending_Status and the request's current pending status in the requesting Participant's and identified Participant's Browser_Clients; WHEN the Verification_Request is confirmed or rejected, THE Human_Bingo_System SHALL display the resulting Square status and recorded outcome in both Participants' Browser_Clients.
9. WHEN a Hosted_Human_Bingo enters Closed_Game, THE Human_Bingo_System SHALL preserve every existing Square status and Verification_Request outcome, SHALL preserve unresolved pending Verification_Requests with Pending_Status, and SHALL reject all subsequent Verification_Request submissions and confirmation or rejection actions.
10. IF a Participant using a Browser_Client attempts to confirm or reject a Verification_Request while not being the identified Participant, THEN THE Human_Bingo_System SHALL reject the action, SHALL display an error indication that only the identified Participant may respond, and SHALL preserve the pending Verification_Request and its Square's Pending_Status.

### Requirement 6: Notify Participants of Verification Requests

**User Story:** As the player identified for a task, I want to receive a clear request for confirmation, so that I can respond to another player's claim.

#### Acceptance Criteria

1. WHEN a Verification_Request is created, THE Human_Bingo_System SHALL create exactly one in-app notification associated with the identified Participant and that Verification_Request, SHALL make the notification available in the identified Participant's pending-request view, and SHALL retain it there until the Verification_Request is resolved.
2. WHERE Browser_Notification is supported and permission has been granted, WHEN a Verification_Request is created, THE Human_Bingo_System SHALL send a Browser_Notification to the identified Participant containing the Hosted_Human_Bingo name, the requesting Participant, and the Task_Entry text associated with the requested Square.
3. WHEN the identified Participant opens an in-app notification for a Verification_Request in Pending_Status, THE Human_Bingo_System SHALL display two distinct actions for that request: one to confirm and one to reject.
4. WHEN the identified Participant confirms or rejects a Verification_Request, THE Human_Bingo_System SHALL mark the associated in-app notification as resolved, SHALL remove that Verification_Request from the identified Participant's pending-request view, and SHALL exclude it from the identified Participant's pending-action count while retaining its resolved state.
5. IF Browser_Notification delivery fails, the browser does not support Browser_Notification, or Browser_Notification permission is unavailable or denied, THEN THE Human_Bingo_System SHALL retain the Verification_Request in Pending_Status and SHALL keep its in-app notification available in the identified Participant's pending-request view as the source of truth.
6. WHEN a Participant has zero Verification_Requests in Pending_Status assigned to that Participant, THE Human_Bingo_System SHALL display a pending-action count of 0.
7. IF an identified Participant opens an in-app notification for a Verification_Request that is no longer in Pending_Status, THEN THE Human_Bingo_System SHALL display the Verification_Request's recorded resolved state and SHALL not provide confirm or reject actions for that request.

### Requirement 7: Synchronize Game State Across Participants

**User Story:** As a Participant, I want game progress to stay current across browser clients and sessions, so that grids, verification requests, and standings reflect the same hosted game state.

#### Acceptance Criteria

1. WHEN a connected Browser_Client submits an accepted action that creates, confirms, or rejects a Verification_Request, THE Human_Bingo_System SHALL persist the resulting Verification_Request record and corresponding Square status in the Authoritative_Web_Backend and SHALL make those resulting records available to every connected Browser_Client for a Participant in that Hosted_Human_Bingo within 5 seconds of accepting the action.
2. WHEN a connected Browser_Client receives a state update for a Hosted_Human_Bingo, THE Human_Bingo_System SHALL update only the Grid, Verification_Requests, Square statuses, or Leaderboard records identified by that update and SHALL preserve every other displayed and persisted record unchanged.
3. WHEN a Browser_Client reconnects after being offline, THE Human_Bingo_System SHALL first synchronize the Browser_Client with the current state stored in the Authoritative_Web_Backend and SHALL prevent submission of every state-dependent action until synchronization succeeds.
4. IF reconnect synchronization fails, THEN THE Human_Bingo_System SHALL prevent submission of state-dependent actions until synchronization succeeds, SHALL display an error indication that synchronization failed, and SHALL preserve the Browser_Client's previously displayed state without applying unsynchronized local changes.
5. WHEN two or more Browser_Clients submit actions targeting the same Square before that Square has a recorded final Verification_Request outcome, THE Human_Bingo_System SHALL process the actions in the order accepted by the Authoritative_Web_Backend, SHALL retain no more than one active Verification_Request for that Square, and SHALL expose the same resulting Verification_Request, outcome, and Square status to every Participant in that Hosted_Human_Bingo.
6. IF a Browser_Client submits a state-dependent action while its displayed state is stale, THEN THE Human_Bingo_System SHALL apply none of that action's changes, SHALL refresh the affected state from the Authoritative_Web_Backend, and SHALL inform the Participant that the action must be retried.
7. WHEN a Participant opens a Hosted_Human_Bingo, THE Human_Bingo_System SHALL display the Participant's Grid, all pending Verification_Requests, all recorded verification outcomes, and all three Leaderboards using values that match the current state stored in the Authoritative_Web_Backend.

### Requirement 8: Maintain the Blackout Leaderboard

**User Story:** As a Participant, I want to see who completes an entire grid first, so that full-game achievement is recognized.

#### Acceptance Criteria

1. WHEN the 25th distinct Square in a Participant's Grid becomes a Verified_Square, THE Human_Bingo_System SHALL record exactly one Blackout completion for that Participant and Hosted_Human_Bingo, including the timestamp at which the 25th distinct Square became Verified_Square.
2. IF a Blackout completion already exists for a Participant and Hosted_Human_Bingo, THEN THE Human_Bingo_System SHALL retain exactly one Blackout completion for that Participant and Hosted_Human_Bingo and SHALL not create another completion or change the Blackout completion count when any Square status is subsequently re-evaluated.
3. WHEN a new Blackout completion is recorded, THE Human_Bingo_System SHALL increase the Hosted_Human_Bingo's total Blackout completion count by exactly one and SHALL associate the completion with the completing Participant and its recorded completion timestamp.
4. IF a Participant's Grid contains fewer than 25 distinct Verified_Squares, THEN THE Human_Bingo_System SHALL not record a Blackout completion for that Participant and Hosted_Human_Bingo and SHALL not increase the Hosted_Human_Bingo's total Blackout completion count.
5. WHEN a Participant opens the Blackout Leaderboard for a Hosted_Human_Bingo, THE Human_Bingo_System SHALL display the total number of recorded Blackout completions and every recorded Blackout completion, ordered by completion timestamp in ascending order and, when timestamps are equal, by Player_Code in ascending lexicographic order; each completion entry SHALL display the completing Participant, the recorded completion timestamp, and the completion's Hosted_Human_Bingo association, and SHALL display an empty state with no completion entries when no Blackout completion is recorded.

### Requirement 9: Maintain the Line Completion Leaderboard

**User Story:** As a Participant, I want line completions to include every standard bingo direction, so that horizontal, vertical, and diagonal achievements are recognized equally.

#### Acceptance Criteria

1. WHEN all 5 Squares in one horizontal Line of a Participant's 5x5 Grid are Verified_Squares, THE Human_Bingo_System SHALL record exactly one Line completion for that Participant, Hosted_Human_Bingo, and horizontal row, identifying the row by its 1-based row number from 1 through 5 and including the timestamp at which the completion is recorded.
2. WHEN all 5 Squares in one vertical Line of a Participant's 5x5 Grid are Verified_Squares, THE Human_Bingo_System SHALL record exactly one Line completion for that Participant, Hosted_Human_Bingo, and vertical column, identifying the column by its 1-based column number from 1 through 5 and including the timestamp at which the completion is recorded.
3. WHEN all 5 Squares in one of the two diagonal Lines of a Participant's 5x5 Grid are Verified_Squares, THE Human_Bingo_System SHALL record exactly one Line completion for that Participant, Hosted_Human_Bingo, and diagonal, identifying the diagonal as either the top-left-to-bottom-right path or the top-right-to-bottom-left path and including the timestamp at which the completion is recorded.
4. IF a Line completion record already exists for a Participant, Hosted_Human_Bingo, and identified Line, THEN THE Human_Bingo_System SHALL retain exactly one completion record for that Line and SHALL not increase that Participant's recorded distinct Line count when the Line's qualifying condition is evaluated again.
5. WHEN a Participant completes multiple distinct Lines, THE Human_Bingo_System SHALL retain exactly one completion record for each distinct Line, where Lines are distinct by direction and position on that Participant's Grid, and SHALL increase the Participant's recorded distinct Line count by exactly one for each newly recorded Line completion.
6. WHEN a Participant opens the Line Leaderboard, THE Human_Bingo_System SHALL display every Participant with at least 1 recorded distinct Line, display each Participant's recorded distinct Line count, order Participants by that count in descending order, order tied Participants by the earliest timestamp at which each Participant's qualifying Line completion was recorded in ascending order, and order any remaining ties by Player_Code in ascending lexicographic order.
7. WHEN no Participant has at least 1 recorded distinct Line, THE Human_Bingo_System SHALL display the Line Leaderboard's empty state and SHALL display no Participant entries.

### Requirement 10: Maintain the Hashtag Completion Leaderboard

**User Story:** As a Participant, I want the fixed Hashtag board pattern to recognize a distinct achievement, so that completing the same defined 16-square pattern is ranked separately from rows, columns, and diagonals.

#### Acceptance Criteria

1. WHEN all 16 distinct Squares in a Participant's 5x5 Grid at the positions in rows 2 and 4 and columns 2 and 4, using 1-based row and column numbering, become Verified_Squares, THE Human_Bingo_System SHALL detect the fixed Hashtag pattern as complete and SHALL record exactly one Hashtag_Completion for that Participant and Hosted_Human_Bingo, including the timestamp at which the completion was recorded.
2. IF fewer than 16 of the fixed Hashtag pattern's 16 distinct Squares are Verified_Squares, THEN THE Human_Bingo_System SHALL not record a Hashtag_Completion for that Participant and Hosted_Human_Bingo and SHALL leave that Hosted_Human_Bingo's Hashtag completion count unchanged.
3. IF a Hashtag_Completion already exists for a Participant and Hosted_Human_Bingo, THEN THE Human_Bingo_System SHALL retain exactly one Hashtag_Completion for that Participant and Hosted_Human_Bingo and SHALL leave the Hashtag completion count unchanged when the pattern is evaluated again or when additional Squares outside the fixed Hashtag pattern become Verified_Squares.
4. WHEN a Hashtag_Completion is recorded, THE Human_Bingo_System SHALL increase the Hosted_Human_Bingo's Hashtag completion count by exactly one and SHALL make the completion record and updated count available to every Participant in that Hosted_Human_Bingo within 5 seconds of receiving the state change.
5. WHEN a Participant opens the Hashtag Leaderboard, THE Human_Bingo_System SHALL display one entry for each Participant with at least one recorded Hashtag_Completion for the fixed 16-Square pattern, SHALL display each entry's recorded Hashtag completion count, SHALL order entries by count in descending order, and SHALL apply the defined Leaderboard tie-break rules when counts are equal.
6. WHEN no Participant has a recorded Hashtag_Completion for the fixed 16-Square pattern, THE Human_Bingo_System SHALL display the empty Hashtag Leaderboard state and SHALL display no Participant entries.

### Requirement 11: Present Unified Leaderboard and Progress States

**User Story:** As a Host or Participant, I want three clearly separated standings, so that each type of achievement can be understood without mixing scoring rules.

#### Acceptance Criteria

1. WHEN a Host or Participant opens a Hosted_Human_Bingo at any supported mobile phone, tablet, or desktop browser viewport width, THE Human_Bingo_System SHALL present exactly three separately labeled Leaderboards named Blackout, Line, and Hashtag in a Responsive_Layout that keeps the primary game view free of horizontal scrolling; each entry SHALL appear only in the Leaderboard whose completion category it represents, and the Hashtag Leaderboard SHALL count only Verified_Squares in the 16 distinct positions consisting of rows 2 and 4 and columns 2 and 4 of the Participant's 5x5 Grid, using 1-based row and column numbering.
2. WHEN a Verified_Square changes a condition that affects one or more completion categories, THE Human_Bingo_System SHALL update every affected Leaderboard entry and total in the same displayed state update, and SHALL not display an affected Leaderboard with its previous completion value after displaying another affected Leaderboard with its new completion value.
3. WHEN two or more Leaderboard entries have the same completion total, THE Human_Bingo_System SHALL order those entries by the earliest timestamp at which each Participant's qualifying completion for that category was recorded in ascending order and, when those timestamps are equal, by Player_Code in ascending lexicographic order.
4. WHEN a Host or Participant views a Participant's Grid, THE Human_Bingo_System SHALL display exactly one current status for each of the 25 Squares, and each status SHALL be exactly one of Unverified_Status, Pending_Status, Rejected_Status, or Verified_Square; the displayed status SHALL be Unverified_Status when no Verification_Request exists, Pending_Status when the latest Verification_Request is awaiting a decision, Rejected_Status when the latest Verification_Request was rejected, and Verified_Square when a Verification_Request was confirmed.
5. WHEN a Verification_Request for a Square has a Rejected_Status, THE Human_Bingo_System SHALL count that Square as zero toward Blackout, Line, and Hashtag completion calculations until a later Verification_Request for that Square reaches Verified_Square.
6. WHEN a Hosted_Human_Bingo enters Closed_Game, THE Human_Bingo_System SHALL preserve and display the three Leaderboards and all 25 current Square statuses as read-only results to the Host and every existing Participant, and SHALL reject subsequent actions that would change Square statuses, Verification_Request outcomes, completion records, or displayed Leaderboard totals.

## Edge Cases

- A Task_Bag with fewer than 25 distinct Task_Entries remains a draft and cannot generate invitations for play.
- Duplicate task text differing only by capitalization or surrounding whitespace is treated as one Task_Entry.
- A Participant opens the same Invitation_Link more than once; the Human_Bingo_System resumes the existing Player_Profile instead of creating a duplicate.
- A Participant enters a valid Player_Code from another Hosted_Human_Bingo; the Human_Bingo_System rejects the request because Player_Code validity is scoped to the current game.
- A Participant attempts to verify a Square with the Participant's own Player_Code; the Human_Bingo_System rejects the request.
- Two participants submit competing requests for the same Square while the first request is pending; the Human_Bingo_System retains one pending request and exposes its deterministic outcome.
- A requested Participant rejects a request; the Square remains available for a later valid request and does not count toward any completion.
- A Browser_Notification is unavailable; the pending request remains available in the in-app notification view.
- A Participant goes offline during a state change; the Human_Bingo_System synchronizes the authoritative state after reconnection and prevents stale actions from silently overwriting newer results.
- A Host closes a game while requests are pending; pending requests remain recorded for history, but no new request or confirmation is accepted after closure.
- Fewer than 16 of the fixed Hashtag pattern's distinct Squares are Verified_Squares; the Human_Bingo_System does not record a Hashtag_Completion.
- The four shared intersections between rows 2 and 4 and columns 2 and 4 count once each, so the fixed Hashtag pattern contains 16 distinct Squares rather than 20.
- A Participant verifies Squares that form unrelated task groupings or labels; those groupings do not count toward the fixed Hashtag pattern or Hashtag_Completion.
- The fixed Hashtag pattern applies to every Participant's Grid, even when the randomized Task_Entry arrangements differ.
- A Participant completes the fixed Hashtag pattern; the Human_Bingo_System records one Hashtag_Completion and does not record another completion when the pattern is evaluated again.
- Two Participants complete a category at the same time; the defined timestamp and Player_Code tie-break rules produce a stable order.

## Non-Functional Expectations

1. THE Human_Bingo_System SHALL protect each Hosted_Human_Bingo's participant and verification data from access by Browser_Clients that are not members of the Hosted_Human_Bingo.
2. THE Human_Bingo_System SHALL preserve persisted Grids, Player_Codes, verification outcomes, notifications, and Leaderboard records in the Authoritative_Web_Backend across browser restarts and SHALL restore those records when a Participant resumes through Resumable_Browser_Access.
3. THE Human_Bingo_System SHALL provide user-visible error messages for invalid input, unavailable invitations, rejected verification, stale state, and synchronization failures.
4. THE Human_Bingo_System SHALL provide a Responsive_Layout that keeps the 5x5 Grid, verification controls, invitation controls, and all three Leaderboards usable on mobile phone, tablet, and desktop browser viewport widths from 320 pixels through desktop widths without requiring horizontal scrolling for the primary game view.
5. THE Human_Bingo_System SHALL make every interactive control in the Responsive_Web_App operable with a keyboard, including grid-square selection, verification actions, invitation actions, and Leaderboard navigation.
6. THE Human_Bingo_System SHALL present normal text and controls with a contrast ratio of at least 4.5:1 and non-text status indicators with a contrast ratio of at least 3:1, and SHALL distinguish Unverified_Status, Pending_Status, Rejected_Status, and Verified_Square using text, icons, patterns, or other non-color-only indicators.


## Scoped Runtime and Local Development Requirements

This section adds implementation and local-development requirements for the existing Human Bingo system. It does not change the game rules or acceptance criteria in Requirements 1–11.

### Additional Glossary

- **Api_Runtime**: The runnable Node.js process that mounts the HTTP API and WebSocket_Gateway and owns startup, health, readiness, and shutdown lifecycle.
- **HttpApi**: The HTTP route handler exposing the existing Human Bingo API contract.
- **WebSocket_Gateway**: The authenticated realtime gateway exposing the existing game event contract.
- **Browser_Dev_Server**: The Vite development server that serves the Browser_Client and proxies API/WebSocket traffic during local development.
- **Production_Static_Server**: The production serving path for the Vite-built Browser_Client assets.
- **Environment_Configuration**: Validated runtime configuration loaded from environment variables or an explicitly documented local environment file.
- **Local_PostgreSQL**: The pinned PostgreSQL service started by Docker Compose for local development and isolated tests.
- **Isolated_Test_Database**: A database or schema reserved for automated tests and never shared with development data.
- **Readiness_Check**: A health endpoint result indicating whether the Api_Runtime can accept traffic, including required dependency checks.

### Requirement 12: Run the Node API and WebSocket Runtime

**User Story:** As a developer, I want one runnable server process, so that the existing HTTP and realtime interfaces can be exercised locally and in deployment.

#### Acceptance Criteria

1. WHEN the Api_Runtime starts with valid Environment_Configuration, THE Api_Runtime SHALL create one Node.js server process, mount the existing HttpApi, mount the WebSocket_Gateway on the documented path, and begin listening on the configured host and port.
2. WHEN the Api_Runtime receives an HTTP request for an existing HttpApi route, THE Api_Runtime SHALL dispatch the request to the existing route contract without changing the route's game semantics or authorization rules.
3. WHEN a WebSocket client connects to the documented gateway path with valid authorization, THE Api_Runtime SHALL dispatch the connection to the existing WebSocket_Gateway contract.
4. IF the Api_Runtime cannot load valid Environment_Configuration or cannot bind the configured listener, THEN THE Api_Runtime SHALL log a redacted startup error, SHALL exit with a non-zero status, and SHALL not report readiness.

### Requirement 13: Serve the Browser Client with Vite

**User Story:** As a developer, I want consistent browser development and production serving, so that the Browser_Client can use the same API and WebSocket contracts in both workflows.

#### Acceptance Criteria

1. WHEN the Browser_Dev_Server starts in development mode, THE Browser_Dev_Server SHALL serve the Browser_Client through Vite, SHALL use the configured browser port, and SHALL proxy documented HTTP API and WebSocket paths to the Api_Runtime.
2. WHEN a production browser build is requested, THE Browser_Dev_Server SHALL produce a deterministic Vite asset output suitable for the Production_Static_Server without requiring the Node Api_Runtime to serve source modules.
3. WHEN the Browser_Client is opened through the documented local development URL, THE Browser_Client SHALL resolve API and WebSocket endpoints using the documented environment configuration without hard-coded machine-specific hostnames.
4. IF the Vite build or proxy configuration is invalid, THEN the development or build command SHALL fail with a non-zero status and SHALL identify the invalid configuration without silently falling back to an incorrect backend.

### Requirement 14: Provide Root Lifecycle Scripts

**User Story:** As a developer, I want predictable root commands, so that I can start, build, preview, test, and stop the local system without knowing package internals.

#### Acceptance Criteria

1. THE Human_Bingo_System SHALL expose root `dev`, `start`, and `preview` scripts with documented single-purpose behavior for local development, API runtime startup, and production browser preview.
2. WHEN a developer runs the root `dev` script with the documented prerequisites, THE Human_Bingo_System SHALL start the Browser_Dev_Server and Api_Runtime with the documented local dependency workflow and SHALL propagate a child-process failure as a non-zero command result.
3. WHEN a developer runs the root `start` script with a production browser build and valid Environment_Configuration, THE Human_Bingo_System SHALL start the Api_Runtime without starting a development watcher.
4. WHEN a developer runs the root `preview` script after a successful browser build, THE Human_Bingo_System SHALL serve the production browser assets at the documented preview URL and SHALL not mutate the database.

### Requirement 15: Expose Health, Readiness, and Graceful Shutdown

**User Story:** As an operator, I want lifecycle endpoints and controlled shutdown, so that local tooling and deployment systems can distinguish a live process from a ready service.

#### Acceptance Criteria

1. WHEN the Api_Runtime is running, THE Api_Runtime SHALL expose a health endpoint that returns a successful response when the process event loop and HTTP listener are functioning.
2. WHEN the Api_Runtime is running and all required startup dependencies are available, THE Api_Runtime SHALL expose a readiness endpoint that returns a successful response and SHALL identify the runtime as ready.
3. IF a required readiness dependency is unavailable, THE Api_Runtime SHALL return a non-success readiness response, SHALL identify the dependency state without secrets, and SHALL continue serving health checks while the process remains alive.
4. WHEN the Api_Runtime receives SIGTERM or SIGINT, THE Api_Runtime SHALL stop accepting new connections, SHALL stop new WebSocket sessions, SHALL allow bounded in-flight work to finish, SHALL close database and gateway resources, and SHALL exit successfully within the configured shutdown timeout.
5. IF graceful shutdown exceeds the configured shutdown timeout, THE Api_Runtime SHALL log the timeout, SHALL close remaining resources using the runtime's forced cleanup path, and SHALL exit with a non-zero status.

### Requirement 16: Run a Pinned Local PostgreSQL Service

**User Story:** As a developer, I want a reproducible local database, so that schema and game behavior can be developed without manually installing PostgreSQL.

#### Acceptance Criteria

1. THE Human_Bingo_System SHALL provide a Docker Compose definition that starts Local_PostgreSQL with an explicitly pinned PostgreSQL image tag, deterministic local port mapping, named persistent volume, health check, and documented credentials/database name.
2. WHEN Local_PostgreSQL is started through the documented Compose command, THE Human_Bingo_System SHALL make the database available only through the documented local-development interface and SHALL report service health through the Compose health check.
3. WHEN a developer tears down the local stack using the documented non-destructive command, THE Human_Bingo_System SHALL stop and remove local containers and networks while preserving the named database volume.
4. WHEN a developer explicitly uses the documented destructive teardown command, THE Human_Bingo_System SHALL remove the named database volume and SHALL state that local database data is deleted.

### Requirement 17: Validate Environment and Manage Databases

**User Story:** As a developer, I want explicit environment and database commands, so that setup failures are detected before application requests fail.

#### Acceptance Criteria

1. WHEN an Api_Runtime, Browser_Dev_Server, or database command starts, THE Human_Bingo_System SHALL validate required Environment_Configuration fields, types, allowed values, and URL/port formats before performing work.
2. IF Environment_Configuration validation fails, THEN THE Human_Bingo_System SHALL report each invalid variable by name and reason, SHALL redact secret values, and SHALL exit with a non-zero status.
3. THE Human_Bingo_System SHALL expose root `db:wait`, `db:create`, `db:migrate`, `db:reset`, and `db:status` commands with documented ordering, exit codes, and target database behavior.
4. WHEN `db:wait` succeeds, THE Human_Bingo_System SHALL return only after Local_PostgreSQL accepts connections; WHEN it times out, THE command SHALL return a non-zero status with actionable diagnostics.
5. WHEN `db:create` or `db:migrate` succeeds, THE Human_Bingo_System SHALL apply the operation to the configured development database and SHALL report the resulting target without exposing credentials.
6. WHEN `db:reset` runs, THE Human_Bingo_System SHALL require the documented local-development safety guard, SHALL recreate the development schema/database, and SHALL not target production-like environments.
7. WHEN `db:status` runs, THE Human_Bingo_System SHALL report migration status for the selected database and SHALL return a non-zero status when migrations are pending or inconsistent.
8. WHEN automated tests start, THE Human_Bingo_System SHALL select an Isolated_Test_Database distinct from the development database, SHALL apply migrations before tests, and SHALL clean or recreate test state without modifying development data.

### Requirement 18: Document First-Run and Operations

**User Story:** As a developer, I want a root README with operational instructions, so that a new contributor can start, verify, troubleshoot, and tear down the system.

#### Acceptance Criteria

1. THE Human_Bingo_System SHALL provide a root README that documents prerequisites, environment setup, first-run command order, root scripts, database commands, local URLs, health/readiness checks, and the isolated test database workflow.
2. WHEN a developer encounters a failed startup, unavailable database, invalid environment, occupied port, failed migration, or stale local container, THE root README SHALL provide a troubleshooting step for that condition.
3. THE root README SHALL document non-destructive teardown and destructive database-volume removal separately and SHALL state the data-loss consequence of destructive teardown.
4. WHEN a documented first-run sequence is followed on a clean checkout with the prerequisites installed, THE root README SHALL lead the developer to a running Browser_Dev_Server, Api_Runtime, healthy Local_PostgreSQL, and successful health/readiness responses.
