/** @implements Sender */
export class CallbackSender {
  private readonly deliver: (text: string) => Promise<void>;

  constructor(deliver: (text: string) => Promise<void>) {
    this.deliver = deliver;
  }

  async send(text: string): Promise<void> {
    await this.deliver(text);
  }
}
