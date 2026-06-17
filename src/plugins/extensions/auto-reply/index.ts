/**
 * Auto-reply reference extension plugin.
 *
 * Demonstrates the Tier-2 capability layer end-to-end: it hooks inbound messages and replies
 * via ctx.messages.reply. Registered DISABLED by default — enable it from the dashboard to try
 * the capability layer live. Replies only to inbound, non-group, engine-originated messages.
 */
import { PluginContext, IPlugin } from '../../../core/plugins';
import { HookContext, HookResult } from '../../../core/hooks';
import { IncomingMessage } from '../../../engine/interfaces/whatsapp-engine.interface';

export class AutoReplyPlugin implements IPlugin {
  onEnable(context: PluginContext): Promise<void> {
    context.registerHook('message:received', ctx => this.onMessage(context, ctx as HookContext<IncomingMessage>));
    context.logger.log('Auto-reply reference plugin enabled');
    return Promise.resolve();
  }

  private async onMessage(context: PluginContext, ctx: HookContext<IncomingMessage>): Promise<HookResult> {
    const message = ctx.data;

    // Reply only to inbound, non-group, engine-originated messages; never to our own sends.
    if (ctx.source !== 'Engine' || !ctx.sessionId || message.fromMe || message.isGroup) {
      return { continue: true };
    }

    try {
      await context.messages.reply(ctx.sessionId, message.chatId, message.id, `Auto-reply: ${message.body}`);
    } catch (error) {
      context.logger.error('Auto-reply failed', error);
    }

    // Keep the inbound message in history + webhooks + ws (do not swallow).
    return { continue: true };
  }
}

export default AutoReplyPlugin;
