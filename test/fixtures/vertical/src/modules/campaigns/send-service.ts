/** The ports the service needs; the Quota and Sender contracts of the designs describe them. */
interface Quota {
  take(accountId: string): Promise<boolean>;
}
interface Sender {
  send(text: string): Promise<void>;
}

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
