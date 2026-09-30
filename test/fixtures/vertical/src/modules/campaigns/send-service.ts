import type { Quota } from "../quota/.design/design.generated.ts";
import type { Sender } from "../mail/.design/design.generated.ts";

/** @implements Send */
export class SendService {
  private readonly quota: Quota;
  private readonly sender: Sender;

  constructor(quota: Quota, sender: Sender) {
    this.quota = quota;
    this.sender = sender;
  }

  async run(accountId: string, text: string): Promise<"sent" | "limited"> {
    if (!(await this.quota.take(accountId))) return "limited";
    await this.sender.send(text);
    return "sent";
  }
}
