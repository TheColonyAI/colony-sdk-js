/**
 * Every caller-supplied value in a request path goes through `pathSegment`.
 *
 * The weakness this closes: `encodeURIComponent` leaves `.` and `..` alone and
 * the URL parser resolves them, so `getPost("..")` sent an authenticated
 * request to a different endpoint. Most ids were interpolated with no encoding
 * at all, so `getPost("x/comments")` or `getPost("../users/me")` left the
 * segment outright. Encoding a `/` is not enough either: the server decodes
 * `%2F` back to `/` before it routes.
 *
 * Three layers, so a new method cannot quietly skip the guard:
 *
 * 1. A source scan of `src/client.ts` (with the TypeScript parser): every
 *    `${...}` in the path part of a request path must be a `pathSegment(...)`
 *    call (or one of the two typed helpers built on it), and no path may be
 *    built by `+` concatenation.
 * 2. An explicit REGISTRY of every (method, parameter) whose value lands in a
 *    path, checked against what the scan finds, so a new path-building method
 *    must be added here. Each entry is then called with `..`, `.`, `""` and a
 *    value containing `/` (refused, nothing sent, not even the token
 *    exchange), and with controls (`...`, `a.b`, `.well-known`, a UUID, a
 *    username with a hyphen, `%2e%2e`), which must still be sent, encoded, as
 *    one segment.
 * 3. A sweep over every public method of `ColonyClient`, found by parsing the
 *    class, called with a bad value in every argument position: no request
 *    may carry a dot segment, an empty segment or a raw `/` from the caller.
 *    This one does not depend on how a path is built.
 */

import ts from "typescript";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ColonyClient, UUID_PATH_PARAMS } from "../src/client.js";
import { COLONIES } from "../src/colonies.js";
import type { MessageAttachmentVariant } from "../src/types.js";
import { retryConfig } from "../src/retry.js";

import { MockFetch } from "./_mockFetch.js";

const CLIENT_SOURCE = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");

const ID = "3f2c8a9e-1b7d-4e5f-9a0b-6c1d2e3f4a5b";
const COLONY_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const BYTES = new Uint8Array([1, 2, 3]);
const ORIGIN = "https://thecolony.ai";

function makeClient(fetchImpl: typeof fetch) {
  return new ColonyClient("col_test_key", {
    fetch: fetchImpl,
    retry: retryConfig({ maxRetries: 0, baseDelay: 0, maxDelay: 0 }),
    tokenCache: false,
  });
}

/**
 * A fetch that answers every request, recording each URL. `/auth/token` gets
 * a token and `GET /colonies` a list holding one colony, `my.colony`, so a
 * colony name the client has to look up resolves.
 */
function answeringFetch(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    let body: unknown = {};
    if (url.endsWith("/auth/token")) body = { access_token: "test-token" };
    else if (url.includes("/colonies?limit=")) body = [{ name: "my.colony", id: COLONY_ID }];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: impl, urls };
}

/** The path of a request URL exactly as sent: no query, not normalised. */
function rawPath(url: string): string {
  expect(url.startsWith(`${ORIGIN}/`)).toBe(true);
  return url.slice(ORIGIN.length).split("?")[0]!.split("#")[0]!;
}

// ── 1. The source scan ───────────────────────────────────────────────────

const GUARDS = new Set(["pathSegment", "fileIdSegment", "versionNumberSegment"]);

interface ScanResult {
  /** `method: expression` for each unguarded interpolation in a path. */
  unguarded: string[];
  /** `method: text` for each path built with `+`. */
  concatenated: string[];
  /** `method:param` for each caller value that lands in a path. */
  segments: Set<string>;
  /** Public instance methods of `ColonyClient`, with their parameter count. */
  publicMethods: Map<string, number>;
}

function scan(source: string): ScanResult {
  const sf = ts.createSourceFile("client.ts", source, ts.ScriptTarget.ES2022, true);
  const result: ScanResult = {
    unguarded: [],
    concatenated: [],
    segments: new Set(),
    publicMethods: new Map(),
  };
  const methodOf = (node: ts.Node): string => {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name) {
        return n.name.getText(sf);
      }
    }
    return "<top level>";
  };
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent)) {
      const flags = ts.getCombinedModifierFlags(node);
      if (!(flags & ts.ModifierFlags.Private) && !(flags & ts.ModifierFlags.Static)) {
        result.publicMethods.set(node.name.getText(sf), node.parameters.length);
      }
    }
    // A request path is a template literal starting with "/". Its path part
    // runs until the first literal "?"; what follows is the query string.
    if (ts.isTemplateExpression(node) && node.head.text.startsWith("/")) {
      let inPath = !node.head.text.includes("?");
      for (const span of node.templateSpans) {
        const expr = span.expression;
        if (inPath) {
          const guarded =
            (ts.isCallExpression(expr) &&
              ts.isIdentifier(expr.expression) &&
              GUARDS.has(expr.expression.text)) ||
            // colonyPath appends the suffix its callers built; each caller's
            // suffix is checked where it is written (see below).
            (methodOf(node) === "colonyPath" && expr.getText(sf) === "rest");
          if (!guarded) result.unguarded.push(`${methodOf(node)}: ${expr.getText(sf)}`);
        }
        if (span.literal.text.includes("?")) inPath = false;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (ts.isStringLiteral(node.left) || ts.isNoSubstitutionTemplateLiteral(node.left)) &&
      node.left.text.startsWith("/")
    ) {
      result.concatenated.push(`${methodOf(node)}: ${node.getText(sf)}`);
    }
    // The values that land in a path: each guard's first argument, and the
    // colony of every `this.colonyPath(colony, ...)`.
    const method = methodOf(node);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GUARDS.has(node.expression.text) &&
      method !== "colonyPath" &&
      !GUARDS.has(method)
    ) {
      const arg = node.arguments[0];
      result.segments.add(`${method}:${arg ? arg.getText(sf) : "?"}`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "colonyPath"
    ) {
      const arg = node.arguments[0];
      result.segments.add(`${method}:${arg ? arg.getText(sf) : "?"}`);
      // The suffix must be written in place, as a literal or a template the
      // rule above scans, never passed in as a variable built elsewhere.
      const rest = node.arguments[1];
      if (
        rest &&
        !ts.isStringLiteral(rest) &&
        !ts.isNoSubstitutionTemplateLiteral(rest) &&
        !ts.isTemplateExpression(rest)
      ) {
        result.unguarded.push(`${method}: colonyPath suffix ${rest.getText(sf)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

const SCAN = scan(CLIENT_SOURCE);

describe("source scan of src/client.ts", () => {
  it("every interpolation in a request path is a pathSegment call", () => {
    expect(SCAN.unguarded).toEqual([]);
  });

  it("no request path is built by concatenation", () => {
    expect(SCAN.concatenated).toEqual([]);
  });

  it("the scan is not vacuous: it reports an unguarded id and a concatenated path", () => {
    // A control on the scanner itself. Without it, a scanner that matched
    // nothing would pass the two tests above forever.
    const planted = scan(`class C {
      async getThing(thingId: string) {
        return this.rawRequest({ method: "GET", path: \`/things/\${thingId}?x=\${thingId}\` });
      }
      async getOther(otherId: string) {
        return this.rawRequest({ method: "GET", path: "/others/" + otherId });
      }
      async getSafe(safeId: string) {
        return this.rawRequest({ method: "GET", path: \`/safe/\${pathSegment(safeId, "safeId")}\` });
      }
      async getInColony(colony: string, suffix: string) {
        return this.rawRequest({ method: "GET", path: await this.colonyPath(colony, suffix) });
      }
    }`);
    expect(planted.unguarded).toEqual([
      "getThing: thingId",
      "getInColony: colonyPath suffix suffix",
    ]);
    expect(planted.concatenated).toEqual(['getOther: "/others/" + otherId']);
    expect([...planted.segments]).toEqual(["getSafe:safeId", "getInColony:colony"]);
    expect([...planted.publicMethods.keys()]).toEqual([
      "getThing",
      "getOther",
      "getSafe",
      "getInColony",
    ]);
  });

  it("finds the public methods to sweep", () => {
    // Several hundred; a parse that found few would make layer 3 vacuous.
    expect(SCAN.publicMethods.size).toBeGreaterThan(250);
  });
});

// ── 2. The registry ──────────────────────────────────────────────────────

type Invoke = (c: ColonyClient, v: string) => Promise<unknown>;

/**
 * Every (method, parameter) whose value lands in a request path. A method
 * added to the client with a path segment and not listed here fails "the
 * registry matches the source" below.
 */
const REGISTRY: Array<[method: string, param: string, invoke: Invoke]> = [
  ["acceptOrgInvitation", "invitationId", (c, v) => c.acceptOrgInvitation(v)],
  ["acceptOwnershipTransfer", "transferId", (c, v) => c.acceptOwnershipTransfer(v)],
  ["addGroupMember", "convId", (c, v) => c.addGroupMember(v, "x")],
  ["addMemberNote", "colony", (c, v) => c.addMemberNote(v, ID, "x")],
  ["addMemberNote", "userId", (c, v) => c.addMemberNote("general", v, "x")],
  ["addMessageReaction", "messageId", (c, v) => c.addMessageReaction(v, "x")],
  ["addOrgDelegationGrant", "slug", (c, v) => c.addOrgDelegationGrant(v, "x", [])],
  ["addOrgOperatedAgent", "slug", (c, v) => c.addOrgOperatedAgent(v, "x")],
  ["addOrgResource", "slug", (c, v) => c.addOrgResource(v, "x")],
  ["addProjectCollaborator", "slug", (c, v) => c.addProjectCollaborator(v, "x")],
  ["addProjectCollaborator", "user", (c, v) => c.addProjectCollaborator("x", v)],
  ["addProjectFile", "slug", (c, v) => c.addProjectFile(v, "x")],
  ["answerCognition", "commentId", (c, v) => c.answerCognition(v, "x", "x")],
  ["answerPostCognition", "postId", (c, v) => c.answerPostCognition(v, "x", "x")],
  ["archiveConversation", "username", (c, v) => c.archiveConversation(v)],
  ["assignMemberFlair", "colony", (c, v) => c.assignMemberFlair(v, ID, ID)],
  ["assignMemberFlair", "userId", (c, v) => c.assignMemberFlair("general", v, ID)],
  ["banColonyMember", "colony", (c, v) => c.banColonyMember(v, ID)],
  ["banColonyMember", "userId", (c, v) => c.banColonyMember("general", v)],
  ["blockUser", "userId", (c, v) => c.blockUser(v)],
  ["bookmarkPost", "postId", (c, v) => c.bookmarkPost(v)],
  ["cancelColonyDeletionRequest", "colony", (c, v) => c.cancelColonyDeletionRequest(v)],
  ["cancelOrgDeletion", "slug", (c, v) => c.cancelOrgDeletion(v)],
  ["cancelOwnershipTransfer", "transferId", (c, v) => c.cancelOwnershipTransfer(v)],
  ["clearMemberFlair", "colony", (c, v) => c.clearMemberFlair(v, ID)],
  ["clearMemberFlair", "userId", (c, v) => c.clearMemberFlair("general", v)],
  ["closePost", "postId", (c, v) => c.closePost(v)],
  ["confirmClaim", "claimId", (c, v) => c.confirmClaim(v)],
  ["conversationHistory", "username", (c, v) => c.conversationHistory(v, "x")],
  ["conversationTail", "username", (c, v) => c.conversationTail(v)],
  ["createAutomodRule", "colony", (c, v) => c.createAutomodRule(v, "x", {}, {})],
  ["createComment", "postId", (c, v) => c.createComment(v, "x")],
  ["createPostFlair", "colony", (c, v) => c.createPostFlair(v, "x")],
  ["createRemovalReason", "colony", (c, v) => c.createRemovalReason(v, "x", "x")],
  ["createUserFlair", "colony", (c, v) => c.createUserFlair(v, "x")],
  ["crosspost", "postId", (c, v) => c.crosspost(v, ID)],
  ["declineOrgInvitation", "invitationId", (c, v) => c.declineOrgInvitation(v)],
  ["declineOwnershipTransfer", "transferId", (c, v) => c.declineOwnershipTransfer(v)],
  ["deleteAutomodRule", "colony", (c, v) => c.deleteAutomodRule(v, ID)],
  ["deleteAutomodRule", "ruleId", (c, v) => c.deleteAutomodRule("general", v)],
  ["deleteComment", "commentId", (c, v) => c.deleteComment(v)],
  ["deleteMemberNote", "colony", (c, v) => c.deleteMemberNote(v, ID, ID)],
  ["deleteMemberNote", "noteId", (c, v) => c.deleteMemberNote("general", ID, v)],
  ["deleteMemberNote", "userId", (c, v) => c.deleteMemberNote("general", v, ID)],
  ["deleteMessage", "messageId", (c, v) => c.deleteMessage(v)],
  ["deleteMessageAttachment", "attachmentId", (c, v) => c.deleteMessageAttachment(v)],
  ["deletePost", "postId", (c, v) => c.deletePost(v)],
  ["deletePostFlair", "colony", (c, v) => c.deletePostFlair(v, ID)],
  ["deletePostFlair", "flairId", (c, v) => c.deletePostFlair("general", v)],
  ["deleteProject", "slug", (c, v) => c.deleteProject(v)],
  ["deleteProjectFile", "fileId", (c, v) => c.deleteProjectFile("x", v)],
  ["deleteProjectFile", "slug", (c, v) => c.deleteProjectFile(v, ID)],
  ["deleteRemovalReason", "colony", (c, v) => c.deleteRemovalReason(v, ID)],
  ["deleteRemovalReason", "reasonId", (c, v) => c.deleteRemovalReason("general", v)],
  ["deleteUserFlair", "colony", (c, v) => c.deleteUserFlair(v, ID)],
  ["deleteUserFlair", "templateId", (c, v) => c.deleteUserFlair("general", v)],
  ["deleteWebhook", "webhookId", (c, v) => c.deleteWebhook(v)],
  ["demoteColonyMember", "colony", (c, v) => c.demoteColonyMember(v, ID)],
  ["demoteColonyMember", "userId", (c, v) => c.demoteColonyMember("general", v)],
  ["dryRunAutomodRule", "colony", (c, v) => c.dryRunAutomodRule(v, "x", {}, {})],
  ["editMessage", "messageId", (c, v) => c.editMessage(v, "x")],
  ["fileColonyDeletionRequest", "colony", (c, v) => c.fileColonyDeletionRequest(v, "x")],
  ["follow", "userId", (c, v) => c.follow(v)],
  ["followByUsername", "username", (c, v) => c.followByUsername(v)],
  ["followTag", "tag", (c, v) => c.followTag(v)],
  ["forwardMessage", "messageId", (c, v) => c.forwardMessage(v, "x")],
  ["getClaim", "claimId", (c, v) => c.getClaim(v)],
  ["getColonyDeletionRequest", "colony", (c, v) => c.getColonyDeletionRequest(v)],
  ["getComments", "postId", (c, v) => c.getComments(v)],
  ["getConversation", "username", (c, v) => c.getConversation(v)],
  ["getFollowers", "userId", (c, v) => c.getFollowers(v)],
  ["getFollowing", "userId", (c, v) => c.getFollowing(v)],
  ["getGroupAvatar", "convId", (c, v) => c.getGroupAvatar(v)],
  ["getGroupConversation", "convId", (c, v) => c.getGroupConversation(v)],
  ["getMessageAttachment", "attachmentId", (c, v) => c.getMessageAttachment(v)],
  [
    "getMessageAttachment",
    "variant",
    (c, v) => c.getMessageAttachment(ID, { variant: v as MessageAttachmentVariant }),
  ],
  ["getModActivity", "colony", (c, v) => c.getModActivity(v)],
  ["getModQueue", "colony", (c, v) => c.getModQueue(v)],
  ["getMyBanStatus", "colony", (c, v) => c.getMyBanStatus(v)],
  ["getOrg", "slug", (c, v) => c.getOrg(v)],
  ["getOrgDeletionStatus", "slug", (c, v) => c.getOrgDeletionStatus(v)],
  ["getPendingOwnershipTransfer", "colony", (c, v) => c.getPendingOwnershipTransfer(v)],
  ["getPoll", "postId", (c, v) => c.getPoll(v)],
  ["getPost", "postId", (c, v) => c.getPost(v)],
  ["getPostContext", "postId", (c, v) => c.getPostContext(v)],
  ["getPostConversation", "postId", (c, v) => c.getPostConversation(v)],
  ["getPostHistory", "postId", (c, v) => c.getPostHistory(v)],
  ["disableOgImage", "postId", (c, v) => c.disableOgImage(v)],
  ["getPremiumInvoice", "paymentHash", (c, v) => c.getPremiumInvoice(v)],
  ["getProject", "slug", (c, v) => c.getProject(v)],
  ["getProjectFile", "fileId", (c, v) => c.getProjectFile("x", v)],
  ["getProjectFile", "slug", (c, v) => c.getProjectFile(v, ID)],
  ["getProjectFileVersion", "fileId", (c, v) => c.getProjectFileVersion("x", v, 1)],
  ["getProjectFileVersion", "slug", (c, v) => c.getProjectFileVersion(v, ID, 1)],
  [
    "getProjectFileVersion",
    "versionNumber",
    (c, v) => c.getProjectFileVersion("x", ID, v as unknown as number),
  ],
  ["getUser", "userId", (c, v) => c.getUser(v)],
  ["getUserByUsername", "username", (c, v) => c.getUserByUsername(v)],
  ["getUserReport", "username", (c, v) => c.getUserReport(v)],
  ["inviteOrgMember", "slug", (c, v) => c.inviteOrgMember(v, "x")],
  ["issueMemberStrike", "colony", (c, v) => c.issueMemberStrike(v, ID, "x")],
  ["issueMemberStrike", "userId", (c, v) => c.issueMemberStrike("general", v, "x")],
  ["joinColony", "colony", (c, v) => c.joinColony(v)],
  ["joinModmail", "colony", (c, v) => c.joinModmail(v, ID)],
  ["joinModmail", "conversationId", (c, v) => c.joinModmail("general", v)],
  ["leaveColony", "colony", (c, v) => c.leaveColony(v)],
  ["leaveOrg", "slug", (c, v) => c.leaveOrg(v)],
  ["listAutomodRules", "colony", (c, v) => c.listAutomodRules(v)],
  ["listBanAppeals", "colony", (c, v) => c.listBanAppeals(v)],
  ["listColonyBans", "colony", (c, v) => c.listColonyBans(v)],
  ["listColonyMembers", "colony", (c, v) => c.listColonyMembers(v)],
  ["listGroupMembers", "convId", (c, v) => c.listGroupMembers(v)],
  ["listMemberNotes", "colony", (c, v) => c.listMemberNotes(v, ID)],
  ["listMemberNotes", "userId", (c, v) => c.listMemberNotes("general", v)],
  ["listMemberStrikes", "colony", (c, v) => c.listMemberStrikes(v, ID)],
  ["listMemberStrikes", "userId", (c, v) => c.listMemberStrikes("general", v)],
  ["listMessageEdits", "messageId", (c, v) => c.listMessageEdits(v)],
  ["listMessageReads", "messageId", (c, v) => c.listMessageReads(v)],
  ["listModmail", "colony", (c, v) => c.listModmail(v)],
  ["listOrgDelegationGrants", "slug", (c, v) => c.listOrgDelegationGrants(v)],
  ["listOrgDomainChallenges", "slug", (c, v) => c.listOrgDomainChallenges(v)],
  ["listOrgMembers", "slug", (c, v) => c.listOrgMembers(v)],
  ["listOrgPendingInvitations", "slug", (c, v) => c.listOrgPendingInvitations(v)],
  ["listOrgResources", "slug", (c, v) => c.listOrgResources(v)],
  ["listPostFlairs", "colony", (c, v) => c.listPostFlairs(v)],
  ["listProjectFileVersions", "fileId", (c, v) => c.listProjectFileVersions("x", v)],
  ["listProjectFileVersions", "slug", (c, v) => c.listProjectFileVersions(v, ID)],
  ["listRemovalReasons", "colony", (c, v) => c.listRemovalReasons(v)],
  ["listUserFlairs", "colony", (c, v) => c.listUserFlairs(v)],
  ["markCommentScanned", "commentId", (c, v) => c.markCommentScanned(v)],
  ["markConversationRead", "username", (c, v) => c.markConversationRead(v)],
  ["markConversationSpam", "username", (c, v) => c.markConversationSpam(v)],
  ["markGroupAllRead", "convId", (c, v) => c.markGroupAllRead(v)],
  ["markMessageRead", "messageId", (c, v) => c.markMessageRead(v)],
  ["markNotificationRead", "notificationId", (c, v) => c.markNotificationRead(v)],
  ["markPostScanned", "postId", (c, v) => c.markPostScanned(v)],
  ["modQueueAction", "colony", (c, v) => c.modQueueAction(v, "open_report", ID, "approve")],
  ["modQueueBulkAction", "colony", (c, v) => c.modQueueBulkAction(v, [])],
  ["movePostToColony", "postId", (c, v) => c.movePostToColony(v, "general")],
  ["muteConversation", "username", (c, v) => c.muteConversation(v)],
  ["muteGroupConversation", "convId", (c, v) => c.muteGroupConversation(v)],
  ["openModmail", "colony", (c, v) => c.openModmail(v, "x")],
  ["pinGroupMessage", "convId", (c, v) => c.pinGroupMessage(v, ID)],
  ["pinGroupMessage", "msgId", (c, v) => c.pinGroupMessage(ID, v)],
  ["pinPost", "postId", (c, v) => c.pinPost(v)],
  ["promoteColonyMember", "colony", (c, v) => c.promoteColonyMember(v, ID)],
  ["promoteColonyMember", "userId", (c, v) => c.promoteColonyMember("general", v)],
  ["proposeOwnershipTransfer", "colony", (c, v) => c.proposeOwnershipTransfer(v, "x")],
  ["rejectClaim", "claimId", (c, v) => c.rejectClaim(v)],
  ["removeColonyMember", "colony", (c, v) => c.removeColonyMember(v, ID)],
  ["removeColonyMember", "userId", (c, v) => c.removeColonyMember("general", v)],
  ["removeGroupMember", "convId", (c, v) => c.removeGroupMember(v, ID)],
  ["removeGroupMember", "userId", (c, v) => c.removeGroupMember(ID, v)],
  ["removeMessageReaction", "emoji", (c, v) => c.removeMessageReaction(ID, v)],
  ["removeMessageReaction", "messageId", (c, v) => c.removeMessageReaction(v, "x")],
  ["removeOrgDelegationGrant", "grantId", (c, v) => c.removeOrgDelegationGrant("x", v)],
  ["removeOrgDelegationGrant", "slug", (c, v) => c.removeOrgDelegationGrant(v, ID)],
  ["removeOrgMember", "slug", (c, v) => c.removeOrgMember(v, ID)],
  ["removeOrgMember", "userId", (c, v) => c.removeOrgMember("x", v)],
  ["removeOrgResource", "resourceId", (c, v) => c.removeOrgResource("x", v)],
  ["removeOrgResource", "slug", (c, v) => c.removeOrgResource(v, ID)],
  ["removeProjectCollaborator", "slug", (c, v) => c.removeProjectCollaborator(v, "x")],
  ["removeProjectCollaborator", "user", (c, v) => c.removeProjectCollaborator("x", v)],
  ["removeProjectFromColony", "slug", (c, v) => c.removeProjectFromColony(v)],
  ["renameOrg", "slug", (c, v) => c.renameOrg(v, "x")],
  ["reopenPost", "postId", (c, v) => c.reopenPost(v)],
  ["reorderAutomodRules", "colony", (c, v) => c.reorderAutomodRules(v, [])],
  ["requestOrgDeletion", "slug", (c, v) => c.requestOrgDeletion(v)],
  ["resolveBanAppeal", "appealId", (c, v) => c.resolveBanAppeal("general", v, true)],
  ["resolveBanAppeal", "colony", (c, v) => c.resolveBanAppeal(v, ID, true)],
  ["respondToGroupInvite", "convId", (c, v) => c.respondToGroupInvite(v, true)],
  ["restoreProjectFileVersion", "fileId", (c, v) => c.restoreProjectFileVersion("x", v, 1)],
  ["restoreProjectFileVersion", "slug", (c, v) => c.restoreProjectFileVersion(v, ID, 1)],
  [
    "restoreProjectFileVersion",
    "versionNumber",
    (c, v) => c.restoreProjectFileVersion("x", ID, v as unknown as number),
  ],
  ["searchGroupMessages", "convId", (c, v) => c.searchGroupMessages(v, "x")],
  ["sendGroupMessage", "convId", (c, v) => c.sendGroupMessage(v, "x")],
  ["sendMessage", "username", (c, v) => c.sendMessage(v, "x")],
  ["setGroupAdmin", "convId", (c, v) => c.setGroupAdmin(v, ID, true)],
  ["setGroupAdmin", "userId", (c, v) => c.setGroupAdmin(ID, v, true)],
  ["setGroupReadReceipts", "convId", (c, v) => c.setGroupReadReceipts(v)],
  ["setOrgDisclosure", "slug", (c, v) => c.setOrgDisclosure(v, "public")],
  ["setOrgMemberRole", "slug", (c, v) => c.setOrgMemberRole(v, ID, "member")],
  ["setOrgMemberRole", "userId", (c, v) => c.setOrgMemberRole("x", v, "member")],
  ["setOrgVisibility", "slug", (c, v) => c.setOrgVisibility(v, true)],
  ["setPostLanguage", "postId", (c, v) => c.setPostLanguage(v, "x")],
  ["setPostTags", "postId", (c, v) => c.setPostTags(v, [])],
  ["setPostCrypto", "postId", (c, v) => c.setPostCrypto(v, { refs: [] })],
  ["snoozeGroupConversation", "convId", (c, v) => c.snoozeGroupConversation(v, "x")],
  ["startOrgDomainChallenge", "slug", (c, v) => c.startOrgDomainChallenge(v, "x", "dns_txt")],
  ["submitBanAppeal", "colony", (c, v) => c.submitBanAppeal(v, "x")],
  ["toggleStarMessage", "messageId", (c, v) => c.toggleStarMessage(v)],
  ["transferGroupCreator", "convId", (c, v) => c.transferGroupCreator(v, "x")],
  ["transferOrgOwnership", "slug", (c, v) => c.transferOrgOwnership(v, ID)],
  ["transferProject", "slug", (c, v) => c.transferProject(v, "x")],
  ["transferProject", "user", (c, v) => c.transferProject("x", v)],
  ["unarchiveConversation", "username", (c, v) => c.unarchiveConversation(v)],
  ["unbanColonyMember", "colony", (c, v) => c.unbanColonyMember(v, ID)],
  ["unbanColonyMember", "userId", (c, v) => c.unbanColonyMember("general", v)],
  ["unblockUser", "userId", (c, v) => c.unblockUser(v)],
  ["unbookmarkPost", "postId", (c, v) => c.unbookmarkPost(v)],
  ["unfollow", "userId", (c, v) => c.unfollow(v)],
  ["unfollowByUsername", "username", (c, v) => c.unfollowByUsername(v)],
  ["unfollowTag", "tag", (c, v) => c.unfollowTag(v)],
  ["unmarkConversationSpam", "username", (c, v) => c.unmarkConversationSpam(v)],
  ["unmuteConversation", "username", (c, v) => c.unmuteConversation(v)],
  ["unmuteGroupConversation", "convId", (c, v) => c.unmuteGroupConversation(v)],
  ["unpinGroupMessage", "convId", (c, v) => c.unpinGroupMessage(v, ID)],
  ["unpinGroupMessage", "msgId", (c, v) => c.unpinGroupMessage(ID, v)],
  ["unsnoozeGroupConversation", "convId", (c, v) => c.unsnoozeGroupConversation(v)],
  ["unwatchPost", "postId", (c, v) => c.unwatchPost(v)],
  ["updateAutomodRule", "colony", (c, v) => c.updateAutomodRule(v, ID, {})],
  ["updateAutomodRule", "ruleId", (c, v) => c.updateAutomodRule("general", v, {})],
  ["updateColonySettings", "colony", (c, v) => c.updateColonySettings(v, {})],
  ["updateComment", "commentId", (c, v) => c.updateComment(v, "x")],
  ["updateGroupConversation", "convId", (c, v) => c.updateGroupConversation(v)],
  ["updatePost", "postId", (c, v) => c.updatePost(v, {})],
  ["updateProject", "slug", (c, v) => c.updateProject(v, {})],
  ["updateProjectFile", "fileId", (c, v) => c.updateProjectFile("x", v, "x")],
  ["updateProjectFile", "slug", (c, v) => c.updateProjectFile(v, ID, "x")],
  ["updateWebhook", "webhookId", (c, v) => c.updateWebhook(v, { isActive: true })],
  ["uploadGroupAvatar", "convId", (c, v) => c.uploadGroupAvatar(v, "x", BYTES, "x")],
  ["vaultDeleteFile", "filename", (c, v) => c.vaultDeleteFile(v)],
  ["vaultGetFile", "filename", (c, v) => c.vaultGetFile(v)],
  ["vaultUploadFile", "filename", (c, v) => c.vaultUploadFile(v, "x")],
  ["verifyOrgDomain", "slug", (c, v) => c.verifyOrgDomain(v)],
  ["voteComment", "commentId", (c, v) => c.voteComment(v)],
  ["votePoll", "postId", (c, v) => c.votePoll(v, ["opt_a"])],
  ["retractPollVote", "postId", (c, v) => c.retractPollVote(v)],
  ["closePoll", "postId", (c, v) => c.closePoll(v)],
  ["updatePoll", "postId", (c, v) => c.updatePoll(v, { closesAt: "2026-11-02T09:00:00Z" })],
  ["votePost", "postId", (c, v) => c.votePost(v)],
  ["watchPost", "postId", (c, v) => c.watchPost(v)],
];

/** How a parameter is checked, by name. Everything else is a plain segment. */
function kindOf(method: string, param: string) {
  if (param === "colony") return "colony";
  if (param === "fileId") return "fileId";
  if (param === "versionNumber") return "versionNumber";
  if (param === "filename" && method.startsWith("vault")) return "vaultPath";
  return "segment";
}

/** Values refused for every kind, before any request. */
const ALWAYS_REFUSED = ["..", ".", ""];

/** Refused as well, per kind. A vault filename may contain `/`; nothing else may. */
const ALSO_REFUSED: Record<ReturnType<typeof kindOf>, string[]> = {
  segment: ["a/b", "../../users/me", "x/..", "/"],
  colony: ["a/b", "../general"],
  fileId: ["a/b", "not-a-uuid", `${ID}/..`],
  versionNumber: ["1", "../.."],
  vaultPath: ["a/../b", "../a", "a/..", "./a", "a/./b", "/a", "a/", "a//b", "/"],
};

/** Controls: each must still be sent, as one segment, percent-encoded. */
const CONTROLS = ["...", "a.b", ".well-known", ID, "dev-maya", "%2e%2e", "a b"];

describe("the registry matches the source", () => {
  it("lists exactly the (method, parameter) pairs that build paths", () => {
    const listed = new Set(REGISTRY.map(([m, p]) => `${m}:${p}`));
    const missing = [...SCAN.segments].filter((s) => !listed.has(s)).sort();
    const stale = [...listed].filter((s) => !SCAN.segments.has(s)).sort();
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it("has no duplicate entries", () => {
    const keys = REGISTRY.map(([m, p]) => `${m}:${p}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("bad path segments are refused before any request", () => {
  for (const [method, param, invoke] of REGISTRY) {
    const kind = kindOf(method, param);
    for (const value of [...ALWAYS_REFUSED, ...ALSO_REFUSED[kind]]) {
      it(`${method} refuses ${param} ${JSON.stringify(value)}`, async () => {
        // No handler is queued, so ANY request (the token exchange included)
        // would also be recorded in `calls`.
        const mock = new MockFetch();
        const err = await invoke(makeClient(mock.fetch), value).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err instanceof RangeError || err instanceof TypeError).toBe(true);
        // Refused by the path guard, naming this parameter, and not by some
        // other local check that would make this test pass vacuously.
        expect((err as Error).message.startsWith(`${param} `)).toBe(true);
        expect(mock.calls).toHaveLength(0);
      });
    }
  }
});

describe("legitimate values are still sent, encoded, as one segment", () => {
  for (const [method, param, invoke] of REGISTRY) {
    const kind = kindOf(method, param);
    const cases: Array<[value: string, segment: string]> =
      kind === "segment"
        ? CONTROLS.map((v) => [v, encodeURIComponent(v)])
        : kind === "vaultPath"
          ? [
              ...CONTROLS.map((v): [string, string] => [v, encodeURIComponent(v)]),
              ["notes/2026-10/draft.md", "notes%2F2026-10%2Fdraft.md"],
              ["a.b/.well-known/...", "a.b%2F.well-known%2F..."],
            ]
          : kind === "colony"
            ? [
                [ID, ID],
                ["general", COLONIES["general"]!],
                // A name the client must look up, with dots in it.
                ["my.colony", COLONY_ID],
              ]
            : kind === "fileId"
              ? [
                  [ID, ID],
                  [ID.toUpperCase(), ID.toUpperCase()],
                ]
              : [
                  // versionNumber: numbers, passed through the string-typed invoker.
                  [1 as unknown as string, "1"],
                  [42 as unknown as string, "42"],
                ];
    for (const [value, segment] of cases) {
      it(`${method} sends ${param} ${JSON.stringify(value)} as ${segment}`, async () => {
        const answering = answeringFetch();
        // The response is a bare `{}`, which some methods then fail to read;
        // only what was SENT matters here.
        await invoke(makeClient(answering.fetch), value).catch(() => undefined);

        const sent = answering.urls.filter(
          (u) => !u.endsWith("/auth/token") && !u.includes("/colonies?limit="),
        );
        expect(sent).toHaveLength(1);
        const path = rawPath(sent[0]!);
        expect(path.split("/")).toContain(segment);
        // The URL parser left the path alone: nothing in it was a dot segment.
        expect(new URL(sent[0]!).pathname).toBe(path);
      });
    }
  }
});

// ── Truncated ids ────────────────────────────────────────────────────────

/**
 * Every registry parameter, by whether the server's value is always a UUID
 * (`format: uuid` in its API document). Each is in exactly one, so a new
 * parameter needs a decision. User ids are not UUID-only: the server takes a
 * username there too, and a username may be all hex.
 */
const NOT_UUID_PARAMS = new Set([
  "colony",
  "emoji",
  "filename",
  "grantId",
  "invitationId",
  "paymentHash",
  "resourceId",
  "slug",
  "tag",
  "user",
  "userId",
  "username",
  "variant",
  "versionNumber",
]);

describe("a truncated id is refused before any request (jack, 2026-10-28)", () => {
  it("decides every registry parameter, UUID or not", () => {
    const params = new Set(REGISTRY.map(([, p]) => p));
    const undecided = [...params].filter(
      (p) => !UUID_PATH_PARAMS.has(p) && !NOT_UUID_PARAMS.has(p),
    );
    const both = [...params].filter((p) => UUID_PATH_PARAMS.has(p) && NOT_UUID_PARAMS.has(p));
    const stale = [...UUID_PATH_PARAMS].filter((p) => !params.has(p));
    expect({ undecided, both, stale }).toEqual({ undecided: [], both: [], stale: [] });
  });

  for (const [method, param, invoke] of REGISTRY) {
    if (!UUID_PATH_PARAMS.has(param)) continue;
    for (const value of [
      "eae899e1",
      "EAE899E1",
      "eae899e1-ab0a-4ba2",
      "eae899e1ab0a4ba2a5a5ea82ea919445",
    ]) {
      it(`${method} refuses ${param} ${JSON.stringify(value)}`, async () => {
        const mock = new MockFetch();
        const err = await invoke(makeClient(mock.fetch), value).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(RangeError);
        expect((err as Error).message.startsWith(`${param} `)).toBe(true);
        if (kindOf(method, param) === "segment") {
          expect((err as Error).message).toContain("looks like a truncated id");
        }
        expect(mock.calls).toHaveLength(0);
      });
    }
  }

  for (const [method, param, invoke] of REGISTRY) {
    if (UUID_PATH_PARAMS.has(param) || kindOf(method, param) !== "segment") continue;
    it(`${method} still sends ${param} "deadbeef12", which may be a real name`, async () => {
      const answering = answeringFetch();
      await invoke(makeClient(answering.fetch), "deadbeef12").catch(() => undefined);
      const sent = answering.urls.filter(
        (u) => !u.endsWith("/auth/token") && !u.includes("/colonies?limit="),
      );
      expect(sent).toHaveLength(1);
      expect(rawPath(sent[0]!).split("/")).toContain("deadbeef12");
    });
  }
});

// ── 3. The sweep over every public method ────────────────────────────────

/**
 * Not swept: `raw` takes the caller's own path, verbatim, by design. It is
 * the escape hatch for endpoints the SDK does not wrap.
 */
const SWEEP_EXEMPT = new Set(["raw"]);

describe("no public method sends a caller's dot segment, empty segment or slash", () => {
  async function callWithEverywhere(method: string, arity: number, value: string) {
    const answering = answeringFetch();
    const client = makeClient(answering.fetch) as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const args = Array.from({ length: arity }, () => value);
    try {
      const result = client[method]!(...args);
      if (result && typeof result === "object" && Symbol.asyncIterator in result) {
        await (result as unknown as AsyncIterator<unknown>).next();
      } else {
        await result;
      }
    } catch {
      // Refused, or failed to read a `{}` response: either way, only the
      // requests it SENT are checked.
    }
    return answering.urls;
  }

  const methods = [...SCAN.publicMethods].filter(([m]) => !SWEEP_EXEMPT.has(m));

  for (const [method, arity] of methods) {
    it(`${method}`, async () => {
      for (const value of ["..", ".", ""]) {
        for (const url of await callWithEverywhere(method, arity, value)) {
          const segments = rawPath(url).split("/").slice(1);
          expect(segments, `${method}(${JSON.stringify(value)}, ...) sent ${url}`).not.toContain(
            "..",
          );
          expect(segments, `${method}(${JSON.stringify(value)}, ...) sent ${url}`).not.toContain(
            ".",
          );
          expect(segments, `${method}(${JSON.stringify(value)}, ...) sent ${url}`).not.toContain(
            "",
          );
        }
      }
      for (const url of await callWithEverywhere(method, arity, "x/y")) {
        expect(rawPath(url), `${method}("x/y", ...) sent ${url}`).not.toContain("x/y");
      }
    });
  }
});

describe("the guard itself", () => {
  it("is what refuses: a disabled guard lets `..` through to the URL parser", () => {
    // What every refusal above prevents, stated directly: the URL parser
    // resolves a dot segment into a different endpoint.
    expect(new URL(`${ORIGIN}/api/v1/posts/..`).pathname).toBe("/api/v1/");
    expect(new URL(`${ORIGIN}/api/v1/posts/%2e%2e/x`).pathname).toBe("/api/v1/x");
    expect(new URL(`${ORIGIN}/api/v1/posts/${encodeURIComponent("%2e%2e")}/x`).pathname).toBe(
      "/api/v1/posts/%252e%252e/x",
    );
  });

  it("names the parameter and the value in its message", async () => {
    const mock = new MockFetch();
    const client = makeClient(mock.fetch);
    await expect(client.getPost("..")).rejects.toThrow(/postId "\.\." cannot be sent/);
    await expect(client.getUser("a/b")).rejects.toThrow(/userId "a\/b" contains "\/"/);
    await expect(client.vaultGetFile("notes/../secret")).rejects.toThrow(
      /filename "notes\/\.\.\/secret" cannot be sent: it has a "\.\." part/,
    );
    await expect(client.vaultGetFile("notes//x")).rejects.toThrow(/it has an empty part/);
    await expect(client.getPost(42 as unknown as string)).rejects.toThrow(TypeError);
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses a bad id before resolving an unmapped colony (no GET /colonies)", async () => {
    // The colony methods check every other segment before the colony lookup,
    // which for a name outside COLONIES is a request of its own.
    const mock = new MockFetch();
    await expect(makeClient(mock.fetch).promoteColonyMember("my.colony", "..")).rejects.toThrow(
      RangeError,
    );
    expect(mock.calls).toHaveLength(0);
  });
});
