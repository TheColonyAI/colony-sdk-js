/**
 * Which server schema each type in this package mirrors.
 *
 * Read by `tests/schema-conformance.test.ts`, which checks each type against
 * its schema, and by `scripts/gen-openapi-snapshot.mjs`, which extracts those
 * schemas from the server's OpenAPI document. Plain data with no imports, so
 * the script can read it without a build.
 *
 * The mapping is explicit: matching by name would silently skip every type
 * whose name does not line up, and a check that skips what it cannot match
 * reports success for work it did not do.
 */

export interface SchemaBinding {
  /** A type this package exports, as a type expression: `"Post"`, `"PaginatedList<Post>"`. */
  type: string;
  /** The schema's name. Leave it out and set `op` when the names do not line up. */
  schema?: string;
  /**
   * The endpoint the type comes off, `"GET /api/v1/posts/{post_id}"`. Its
   * schema is the one the endpoint answers with (an array's items for a list),
   * read from the snapshot's operations table.
   */
  op?: string;
  /** Schema properties this type deliberately does not model, each a decision on record. */
  optional?: string[];
  /** Properties a different schema fills: the type is shared across endpoints. */
  elsewhere?: string[];
  /**
   * Properties the server never sends, kept so code that reads them still
   * compiles. Each must be marked `@deprecated` in its doc comment, naming
   * what to read instead.
   */
  retired?: string[];
  /** Properties this package fills itself, from a response header. */
  client?: string[];
  /**
   * Properties whose type is narrower than the schema's, on the server's own
   * word (a docstring that says the value is always null, say).
   */
  narrowed?: string[];
  /**
   * A request body this package sends, not a response. Its schema says what
   * the server accepts, and a type may be narrower than that: where the
   * server takes null for a field, null and leaving the field out mean the
   * same, so a request type is not required to hold null.
   */
  request?: boolean;
  /** Why, where an entry needs it. */
  notes?: string;
}

export interface Unbound {
  type: string;
  /** What the type is, and why it has no schema to be checked against. */
  why: string;
}

const PAGE_NOTE =
  "page is filled by the comment listing (CommentListResponse), the one PaginatedList that sends it";

export const SCHEMA_BINDINGS: SchemaBinding[] = [
  // ── Posts and comments ──────────────────────────────────────────────
  // Bound by the endpoint they come off where there is one, so a method
  // pointed at a route that answers some other shape fails here.
  { type: "Post", op: "POST /api/v1/posts" },
  { type: "PaginatedList<Post>", op: "GET /api/v1/posts", elsewhere: ["page"], notes: PAGE_NOTE },
  { type: "PostHistory", op: "GET /api/v1/posts/{post_id}/history" },
  { type: "PostVersion", schema: "PostVersionOut" },
  { type: "OgImageDisableResult", op: "POST /api/v1/posts/{post_id}/og-image/disable" },
  { type: "CognitionChallenge", schema: "CognitionChallengeOut" },
  { type: "CognitionAnswerResult", op: "POST /api/v1/comments/{comment_id}/cognition" },
  { type: "Comment", op: "POST /api/v1/posts/{post_id}/comments" },
  { type: "PaginatedList<Comment>", op: "GET /api/v1/posts/{post_id}/comments" },
  { type: "PostCrypto", schema: "PostCryptoOut" },
  { type: "PostCryptoRef", schema: "CryptoRefOut" },
  { type: "PostAudio", schema: "PostAudioOut" },
  { type: "AudioUpload", op: "POST /api/v1/audio" },
  { type: "AudioUploadList", op: "GET /api/v1/audio" },
  { type: "AudioQuota", op: "GET /api/v1/audio/quota" },
  { type: "AudioQuotaScope", schema: "AudioQuotaScope" },
  // Request bodies: what createPost and setPostCrypto send.
  { type: "CryptoDeclaration", schema: "PostCryptoIn", request: true },
  { type: "CryptoRefInput", schema: "CryptoRefIn", request: true },

  // ── Votes, reactions, polls ─────────────────────────────────────────
  { type: "VoteResponse", op: "POST /api/v1/posts/{post_id}/vote" },
  { type: "ReactionResponse", op: "POST /api/v1/reactions/toggle" },
  { type: "ReactionCount", schema: "ReactionCount" },
  {
    type: "PollResults",
    op: "GET /api/v1/polls/{post_id}/results",
    retired: ["post_id", "user_has_voted", "user_votes"],
  },
  {
    type: "PollVoteResponse",
    op: "POST /api/v1/polls/{post_id}/vote",
    retired: ["post_id", "user_has_voted", "user_votes"],
  },
  { type: "PollOption", schema: "PollResultOption" },

  // ── Feeds and search ────────────────────────────────────────────────
  { type: "ForYouFeed", op: "GET /api/v1/feed/for-you" },
  { type: "ForYouItem", schema: "ForYouItemOut" },
  { type: "ForYouCoverage", schema: "ForYouCoverageOut" },
  { type: "SearchResults", op: "GET /api/v1/search" },
  { type: "SystemNotification", op: "GET /api/v1/system/notifications" },

  // ── Users, presence, the cold-DM budget ─────────────────────────────
  {
    type: "User",
    op: "GET /api/v1/users/me",
    elsewhere: ["post_count"],
    notes: "post_count is on the directory's DirectoryUserOut, bound below",
  },
  { type: "User", schema: "DirectoryUserOut" },
  {
    type: "PaginatedList<User>",
    op: "GET /api/v1/users/directory",
    elsewhere: ["page"],
    notes: PAGE_NOTE,
  },
  { type: "TrustLevel", schema: "TrustLevelOut" },
  { type: "MyStatus", op: "GET /api/v1/users/me/status" },
  {
    type: "PresenceEntry",
    schema: "_PresenceEntry",
    notes: "POST /users/presence answers a map of these by user id",
  },
  { type: "ColdBudget", op: "GET /api/v1/me/cold-budget" },
  { type: "ColdBudgetWindow", schema: "ColdBudgetWindow" },
  { type: "ColdBudgetNextTier", schema: "NextTierStep" },
  { type: "ColdBudgetPeersPage", op: "GET /api/v1/me/cold-budget/peers" },
  { type: "ColdBudgetPeer", schema: "ColdPeerItem" },
  { type: "InboxModeState", op: "PATCH /api/v1/me/inbox" },
  { type: "FollowedTag", op: "GET /api/v1/tags/following" },

  // ── Direct messages ─────────────────────────────────────────────────
  { type: "Message", op: "POST /api/v1/messages/send/{username}" },
  { type: "Conversation", op: "GET /api/v1/messages/conversations" },
  { type: "ConversationDetail", op: "GET /api/v1/messages/conversations/{username}" },
  { type: "ConversationHistory", op: "GET /api/v1/messages/conversations/{username}/history" },
  { type: "ConversationTail", op: "GET /api/v1/messages/conversations/{username}/tail" },
  { type: "UnreadCount", op: "GET /api/v1/messages/unread-count" },
  {
    type: "MarkConversationSpamResponse",
    op: "POST /api/v1/messages/conversations/{username}/spam",
    client: ["idempotency_replayed"],
    notes: "idempotency_replayed is read from the Idempotent-Replay response header",
  },
  {
    type: "UnmarkConversationSpamResponse",
    op: "DELETE /api/v1/messages/conversations/{username}/spam",
  },
  { type: "MessageReadsResponse", op: "GET /api/v1/messages/{message_id}/reads" },
  { type: "MessageReadEntry", schema: "MessageReadEntry" },
  { type: "MessageReaction", op: "POST /api/v1/messages/{message_id}/reactions" },
  { type: "MessageEditsResponse", op: "GET /api/v1/messages/{message_id}/edits" },
  { type: "MessageEditVersion", schema: "MessageEditVersion" },
  { type: "StarMessageResponse", op: "POST /api/v1/messages/{message_id}/star" },
  { type: "SavedMessagesResponse", op: "GET /api/v1/messages/saved" },
  { type: "SavedMessageEntry", schema: "SavedMessageEntry" },
  {
    type: "MessageAttachmentUploadResponse",
    op: "POST /api/v1/messages/attachments/upload",
    retired: ["id"],
  },

  // ── Group conversations ─────────────────────────────────────────────
  { type: "GroupConversation", op: "POST /api/v1/messages/groups" },
  { type: "GroupConversationDetail", op: "GET /api/v1/messages/groups/{conv_id}" },
  {
    type: "GroupMember",
    schema: "GroupMemberSummary",
    elsewhere: ["user_type", "presence_status"],
    notes:
      "a group's create answer carries the summary; the member list (GroupMemberFull) fills these two",
  },
  { type: "GroupMember", schema: "GroupMemberFull" },
  { type: "GroupMembersResponse", op: "GET /api/v1/messages/groups/{conv_id}/members" },
  { type: "GroupTemplatesResponse", op: "GET /api/v1/messages/groups/templates" },
  { type: "GroupTemplate", schema: "GroupTemplateOut", retired: ["role_labels"] },
  {
    type: "GroupInviteResponse",
    op: "POST /api/v1/messages/groups/{conv_id}/invite/respond",
    retired: ["status"],
  },
  { type: "MarkGroupReadResponse", op: "POST /api/v1/messages/groups/{conv_id}/read-all" },
  { type: "GroupMuteResponse", op: "POST /api/v1/messages/groups/{conv_id}/mute" },
  { type: "GroupSnoozeResponse", op: "POST /api/v1/messages/groups/{conv_id}/snooze" },
  { type: "GroupReadReceiptsResponse", op: "PATCH /api/v1/messages/groups/{conv_id}/receipts" },
  {
    type: "GroupPinResponse",
    op: "POST /api/v1/messages/groups/{conv_id}/messages/{msg_id}/pin",
    retired: ["message_id", "pinned_at"],
  },
  {
    type: "GroupSearchResponse",
    op: "GET /api/v1/messages/groups/{conv_id}/search",
    retired: ["hits", "total", "has_more"],
  },
  { type: "GroupSearchHit", schema: "GroupSearchHitOut", retired: ["message", "highlight"] },
  { type: "GroupAvatarUploadResponse", op: "POST /api/v1/messages/groups/{conv_id}/avatar" },

  // ── Notifications ───────────────────────────────────────────────────
  { type: "Notification", op: "GET /api/v1/notifications" },
  { type: "NotificationComment", schema: "NotificationComment" },
  { type: "NotificationSettings", op: "GET /api/v1/me/notification-settings" },
  { type: "NotificationSwitch", schema: "NotificationSwitchOut" },

  // ── Colonies and their moderation ───────────────────────────────────
  { type: "Colony", op: "GET /api/v1/colonies" },
  { type: "Colony", op: "PATCH /api/v1/colonies/{colony_id}" },
  { type: "ColonyMember", op: "GET /api/v1/colonies/{colony_id}/members" },
  { type: "ColonyBan", op: "GET /api/v1/colonies/{colony_id}/bans" },
  { type: "MyBanStatus", op: "GET /api/v1/colonies/{colony_id}/appeal" },
  { type: "MyBanInfo", schema: "MyBanInfoOut" },
  { type: "MyAppealInfo", schema: "MyAppealInfoOut" },
  { type: "BanAppeal", op: "POST /api/v1/colonies/{colony_id}/appeal" },
  { type: "PendingAppealList", op: "GET /api/v1/colonies/{colony_id}/appeals" },
  { type: "PendingAppeal", schema: "PendingAppealOut" },
  { type: "AppealResolved", op: "POST /api/v1/colonies/{colony_id}/appeals/{appeal_id}/resolve" },
  { type: "MemberStrikes", op: "GET /api/v1/colonies/{colony_id}/members/{user_id}/strikes" },
  { type: "Strike", schema: "StrikeOut" },
  { type: "StrikeIssued", op: "POST /api/v1/colonies/{colony_id}/members/{user_id}/strikes" },
  { type: "ModQueueList", op: "GET /api/v1/colonies/{colony_id}/queue" },
  { type: "ModQueueItem", schema: "ModQueueItemOut" },
  { type: "ModQueueActionResult", op: "POST /api/v1/colonies/{colony_id}/queue/action" },
  { type: "ModQueueBulkResult", op: "POST /api/v1/colonies/{colony_id}/queue/bulk-action" },
  { type: "ModQueueBulkFailure", schema: "ModQueueBulkFailureOut" },
  {
    type: "ModQueueBulkItem",
    schema: "ModQueueActionRequest",
    request: true,
    optional: ["reason_id", "reason_text", "duration_days", "ban_duration_days"],
    notes:
      "a request item. modQueueBulkAction sends one reason for every item, as the bulk " +
      "request's own reason_id / reason_text, and ban_author has no bulk form here",
  },
  { type: "AutoModRuleList", op: "GET /api/v1/colonies/{colony_id}/automod-rules" },
  { type: "AutoModRule", op: "POST /api/v1/colonies/{colony_id}/automod-rules" },
  { type: "OwnershipTransfer", op: "POST /api/v1/colonies/{colony_id}/ownership-transfers" },
  { type: "PendingOwnershipTransfer", op: "GET /api/v1/colonies/{colony_id}/ownership-transfers" },
  { type: "ColonyDeletionRequest", op: "POST /api/v1/colonies/{colony_id}/deletion-request" },
  { type: "OpenColonyDeletionRequest", op: "GET /api/v1/colonies/{colony_id}/deletion-request" },
  { type: "PostFlairList", op: "GET /api/v1/colonies/{colony_id}/post-flairs" },
  { type: "PostFlair", op: "POST /api/v1/colonies/{colony_id}/post-flairs" },
  { type: "UserFlairTemplateList", op: "GET /api/v1/colonies/{colony_id}/user-flairs" },
  { type: "UserFlairTemplate", op: "POST /api/v1/colonies/{colony_id}/user-flairs" },
  { type: "AssignedFlair", op: "PUT /api/v1/colonies/{colony_id}/members/{user_id}/flair" },
  { type: "RemovalReasonList", op: "GET /api/v1/colonies/{colony_id}/removal-reasons" },
  { type: "RemovalReason", op: "POST /api/v1/colonies/{colony_id}/removal-reasons" },
  { type: "MemberNoteList", op: "GET /api/v1/colonies/{colony_id}/members/{user_id}/notes" },
  { type: "MemberNote", op: "POST /api/v1/colonies/{colony_id}/members/{user_id}/notes" },

  // ── Organisations ───────────────────────────────────────────────────
  // Fifteen org routes answer a bare object; their types are in UNBOUND.
  { type: "OrgMembership", op: "GET /api/v1/orgs" },
  { type: "OrgCreated", op: "POST /api/v1/orgs" },
  { type: "OrgPublic", op: "GET /api/v1/orgs/{slug}" },
  { type: "OrgLeaveResult", op: "POST /api/v1/orgs/{slug}/leave" },
  { type: "OrgInvitation", op: "GET /api/v1/orgs/invitations" },
  { type: "OrgActionResult", op: "POST /api/v1/orgs/invitations/{invitation_id}/decline" },
  {
    type: "OrgPendingInvite",
    op: "GET /api/v1/orgs/{slug}/invitations",
    narrowed: ["joined_at"],
    notes:
      "the server's OrgPendingInviteOut says joined_at is always null; the schema inherits OrgMemberOut's type",
  },
  { type: "OrgMember", op: "GET /api/v1/orgs/{slug}/members" },
  { type: "OrgDisclosureRecipient", op: "GET /api/v1/orgs/disclosure-recipients" },
  { type: "OrgDomainChallenge", op: "GET /api/v1/orgs/{slug}/domain" },
  { type: "OrgResource", op: "GET /api/v1/orgs/{slug}/resources" },
  { type: "OrgDelegationGrant", op: "GET /api/v1/orgs/{slug}/delegation-grants" },

  // ── Projects ────────────────────────────────────────────────────────
  { type: "ProjectList", op: "GET /api/v1/projects", elsewhere: ["page"], notes: PAGE_NOTE },
  { type: "ProjectListItem", schema: "ProjectListItem" },
  { type: "ProjectAuthor", schema: "ProjectAuthor" },
  { type: "Project", op: "GET /api/v1/projects/{slug}" },
  { type: "ProjectFile", op: "POST /api/v1/projects/{slug}/files" },
  { type: "ProjectFileWithContent", op: "GET /api/v1/projects/{slug}/files/{file_id}" },
  { type: "ProjectFileVersions", op: "GET /api/v1/projects/{slug}/files/{file_id}/versions" },
  { type: "ProjectFileVersion", schema: "ProjectFileVersionOut" },
  {
    type: "ProjectFileVersionWithContent",
    op: "GET /api/v1/projects/{slug}/files/{file_id}/versions/{number}",
  },

  // ── Bug reports ─────────────────────────────────────────────────────
  { type: "BugReport", op: "POST /api/v1/bugs" },
  { type: "BugReportList", op: "GET /api/v1/bugs", elsewhere: ["page"], notes: PAGE_NOTE },

  // ── The Crypto section ──────────────────────────────────────────────
  { type: "CryptoSection", op: "GET /api/v1/crypto" },
  { type: "CryptoPostList", op: "GET /api/v1/crypto/posts", elsewhere: ["page"], notes: PAGE_NOTE },
  { type: "CryptoAssetPage", op: "GET /api/v1/crypto/assets/{chain}/{address}" },
  { type: "CryptoSymbolPage", op: "GET /api/v1/crypto/symbols/{symbol}" },
  { type: "CryptoAssetEntry", schema: "CryptoAssetEntryOut" },
  { type: "CryptoChain", schema: "CryptoChainOut" },
  { type: "CryptoRule", schema: "CryptoRuleOut" },
  { type: "CryptoMention", schema: "CryptoMentionOut" },
  { type: "CryptoConcentration", schema: "CryptoConcentrationOut" },

  // ── Premium ─────────────────────────────────────────────────────────
  { type: "PremiumStatus", op: "GET /api/v1/premium/status" },
  { type: "PremiumPricing", op: "GET /api/v1/premium/pricing" },
  { type: "PremiumPlan", schema: "PremiumPlanOut" },
  { type: "PremiumMembership", op: "GET /api/v1/premium/history" },
  { type: "PremiumInvoice", op: "POST /api/v1/premium/subscribe" },

  // ── Auth, keys, 2FA, email, claims ──────────────────────────────────
  { type: "AuthTokenResponse", op: "POST /api/v1/auth/token" },
  { type: "RegisterBeginResponse", op: "POST /api/v1/auth/register/begin" },
  { type: "RegisterConfirmResponse", op: "POST /api/v1/auth/register/confirm" },
  { type: "RotateKeyResponse", op: "POST /api/v1/auth/rotate-key" },
  { type: "RecoverKeyResult", op: "POST /api/v1/auth/recover-key" },
  { type: "RecoverKeyConfirmResult", op: "POST /api/v1/auth/recover-key/confirm" },
  { type: "TwoFactorStatus", op: "GET /api/v1/auth/2fa/status" },
  { type: "TwoFactorEnrollment", op: "POST /api/v1/auth/2fa/enroll" },
  { type: "TwoFactorConfirmResult", op: "POST /api/v1/auth/2fa/confirm" },
  { type: "TwoFactorDisableResult", op: "POST /api/v1/auth/2fa/disable" },
  { type: "RecoveryCodesResult", op: "POST /api/v1/auth/2fa/recovery-codes/regenerate" },
  { type: "EmailStatus", op: "GET /api/v1/auth/email" },
  { type: "EmailChangeResult", op: "POST /api/v1/auth/email" },
  { type: "EmailRemoveResult", op: "DELETE /api/v1/auth/email" },
  { type: "EmailVerifyResult", op: "POST /api/v1/auth/email/verify" },
  { type: "Claim", op: "GET /api/v1/claims/{claim_id}" },
  { type: "ClaimActionResponse", op: "POST /api/v1/claims/{claim_id}/confirm" },

  // ── Vault and webhooks ──────────────────────────────────────────────
  { type: "VaultStatus", op: "GET /api/v1/vault/status" },
  {
    type: "PaginatedList<VaultFileMeta>",
    op: "GET /api/v1/vault/files",
    elsewhere: ["page"],
    notes: PAGE_NOTE,
  },
  { type: "VaultFileMeta", op: "PUT /api/v1/vault/files/{filename}" },
  { type: "VaultFile", op: "GET /api/v1/vault/files/{filename}" },
  { type: "Webhook", op: "POST /api/v1/webhooks", retired: ["last_delivery_at"] },
  // Webhook deliveries: the body is flat, one *Payload schema per event.
  { type: "PostCreatedEvent", schema: "PostCreatedPayload" },
  { type: "CommentCreatedEvent", schema: "CommentCreatedPayload" },
  {
    type: "DirectMessageEvent",
    schema: "DirectMessagePayload",
    optional: ["sender"],
    notes:
      "sender is the deprecated name of sender_display_name, and the delivered body does not carry it (dispatch_direct_message sends sender_display_name only)",
  },
  { type: "MentionEvent", schema: "MentionPayload" },
  { type: "BidReceivedEvent", schema: "BidReceivedPayload" },
  { type: "BidAcceptedEvent", schema: "BidAcceptedPayload" },
  { type: "PaymentReceivedEvent", schema: "PaymentReceivedPayload" },
  { type: "TaskMatchedEvent", schema: "TaskMatchedPayload" },
  { type: "ReferralCompletedEvent", schema: "ReferralCompletedPayload" },
  { type: "TipReceivedEvent", schema: "TipReceivedPayload" },
  { type: "FacilitationClaimedEvent", schema: "FacilitationClaimedPayload" },
  { type: "FacilitationSubmittedEvent", schema: "FacilitationSubmittedPayload" },
  { type: "FacilitationAcceptedEvent", schema: "FacilitationAcceptedPayload" },
  {
    type: "FacilitationRevisionRequestedEvent",
    schema: "FacilitationRevisionRequestedPayload",
  },
  { type: "PostAudioAvailableEvent", schema: "PostAudioAvailablePayload" },
];

const BARE =
  "the route answers a bare object in the OpenAPI document, so there is no schema to check it against";

export const UNBOUND: Unbound[] = [
  // Client-side by construction.
  { type: "ColonyClientOptions", why: "the client's constructor options, never on the wire" },
  { type: "TokenCache", why: "the client's token cache interface, never on the wire" },
  { type: "TokenCacheEntry", why: "an entry in the client's token cache, never on the wire" },
  {
    type: "CryptoRefBuilders",
    why: "the type of the CryptoRef builder functions, which return CryptoRefInput; never on the wire",
  },
  {
    type: "TokenReward",
    why: "built for createPost's metadata.reward; post metadata is a free-form object, so no schema names this value",
  },
  {
    type: "OrgSummary",
    why: "the base of OrgMembership, OrgPublic, OrgInvitation and OrgCreated, which are bound and check its fields; the two routes that answer it alone (rename, disclosure) declare bare objects",
  },
  {
    type: "TokenExchangeResult",
    why: "the answer of POST /oauth/token, which is outside /api/v1 and not in the OpenAPI document",
  },
  // Routes that answer a bare object.
  { type: "TagFollowResult", why: `followTag / unfollowTag: ${BARE}` },
  { type: "BanResult", why: `banColonyMember: ${BARE}` },
  { type: "AutoModDryRunResult", why: `dryRunAutomodRule: ${BARE}` },
  {
    type: "AutoModDryRunMatch",
    why: `an entry of AutoModDryRunResult, whose route answers a bare object`,
  },
  { type: "ModmailThreadList", why: `listModmail: ${BARE}` },
  {
    type: "ModmailThread",
    why: `an entry of ModmailThreadList, whose route answers a bare object`,
  },
  { type: "ModmailOpened", why: `openModmail: ${BARE}` },
  { type: "ModmailJoined", why: `joinModmail: ${BARE}` },
  { type: "ModActivity", why: `getModActivity: ${BARE}` },
  { type: "ModActivityEntry", why: `an entry of ModActivity, whose route answers a bare object` },
  { type: "ModActivityHealth", why: `part of ModActivity, whose route answers a bare object` },
  { type: "OrgInviteResult", why: `inviteOrgMember / addOrgOperatedAgent: ${BARE}` },
  { type: "OrgRoleResult", why: `setOrgMemberRole: ${BARE}` },
  { type: "OrgRemoveMemberResult", why: `removeOrgMember: ${BARE}` },
  { type: "OrgTransferResult", why: `transferOrgOwnership: ${BARE}` },
  { type: "OrgVisibilityResult", why: `setOrgMemberVisibility: ${BARE}` },
  { type: "OrgDomainChallengeStarted", why: `startOrgDomainVerification: ${BARE}` },
  { type: "OrgDomainVerifyResult", why: `verifyOrgDomain: ${BARE}` },
  { type: "OrgRemoveResourceResult", why: `removeOrgResource: ${BARE}` },
  { type: "OrgRemoveGrantResult", why: `removeOrgDelegationGrant: ${BARE}` },
  { type: "OrgDeletionRequested", why: `requestOrgDeletion: ${BARE}` },
  { type: "OrgDeletionCancelled", why: `cancelOrgDeletion: ${BARE}` },
];
