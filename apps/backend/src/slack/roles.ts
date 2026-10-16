/**
 * Who is allowed to command the agent.
 *
 * The config is written in the names people use (@handles), but decisions never
 * run on names: the list is resolved to immutable member IDs the first time it
 * is needed, and every call after that compares IDs. A handle can be renamed
 * and a display name can be imitated; the ID cannot.
 *
 * Slack's own answer is checked too: workspace admins and owners are always
 * maintainers. That is not a convenience - it is the same rule a person would
 * apply reading the member list, and it means a workspace does not have to
 * write its owner's name down for the agent to work.
 *
 * Every failure comes back as `guest`. An identity service being down must
 * never be a way to be promoted.
 */
import type { Authority, SlackClient } from "./index.js";

export class SlackRoles {
  /** Member ID -> verdict, once a verdict is final. */
  private readonly verdicts = new Map<string, Authority>();
  /** IDs of the configured maintainers. Null until resolved. */
  private resolvedIds: Set<string> | null = null;

  constructor(
    private readonly client: SlackClient,
    private readonly configured: string[],
  ) {}

  /**
   * The verdict for one member.
   *
   * Anything that goes wrong answers `guest`, and a verdict that could not be
   * checked is not cached - so the next message tries again instead of
   * inheriting an outage.
   */
  async authorityFor(userId: string): Promise<Authority> {
    const cached = this.verdicts.get(userId);
    if (cached) return cached;

    // The configured list goes first because it needs no API call once
    // resolved - a configured maintainer must survive Slack being slow.
    let listed: boolean | null = false;
    if (this.configured.length > 0) listed = await this.onList(userId);
    if (listed === true) {
      this.verdicts.set(userId, "maintainer");
      return "maintainer";
    }

    const user = await this.client.usersInfo(userId);
    if (!user) return "guest"; // Slack did not answer, or does not know them

    if (user.is_admin || user.is_owner || user.is_primary_owner) {
      this.verdicts.set(userId, "maintainer");
      return "maintainer";
    }

    // The list could not be checked; do not cache an answer that may be wrong.
    if (listed === null) return "guest";

    this.verdicts.set(userId, "guest");
    return "guest";
  }

  private async onList(userId: string): Promise<boolean | null> {
    if (!this.resolvedIds) {
      try {
        await this.resolve();
      } catch (error) {
        console.warn(
          `[slack] could not resolve PICTO_MAINTAINERS, treating this request as a guest's: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    }
    return this.resolvedIds?.has(userId) ?? false;
  }

  /**
   * Turn the configured handles (or IDs) into member IDs, once.
   *
   * `name` is the unique handle Slack shows as @someone, and it is the only
   * field worth trusting: a display name is free text that two members can
   * share, so a display name that fits more than one member resolves to nobody
   * rather than to whoever came last in the member list - and a handle match is
   * never displaced by one.
   */
  private async resolve(): Promise<void> {
    const members = await this.client.usersList();

    const byHandle = new Map<string, string>();
    const byDisplay = new Map<string, string | null>(); // null = more than one member
    for (const member of members) {
      if (!member.id || member.deleted) continue;
      if (member.name) byHandle.set(member.name.toLowerCase(), member.id);
      const display = member.profile?.display_name?.trim().toLowerCase();
      if (display) byDisplay.set(display, byDisplay.has(display) ? null : member.id);
    }

    const ids = new Set<string>();
    const unmatched: string[] = [];
    for (const entry of this.configured) {
      if (/^[UW][A-Z0-9]{4,}$/i.test(entry)) {
        ids.add(entry.toUpperCase());
        continue;
      }
      const wanted = entry.toLowerCase();
      const id = byHandle.get(wanted) ?? byDisplay.get(wanted) ?? undefined;
      if (id) ids.add(id);
      else unmatched.push(entry);
    }

    this.resolvedIds = ids;
    if (unmatched.length > 0) {
      console.warn(
        `[slack] PICTO_MAINTAINERS entries matching no member (or more than one display name): ${unmatched.join(", ")}`,
      );
    }
    console.log(
      `[slack] PICTO_MAINTAINERS: ${ids.size} of ${this.configured.length} resolved to member ids`,
    );
  }
}
