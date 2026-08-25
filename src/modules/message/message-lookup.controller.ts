import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { MessageService } from './message.service';
import { Message } from './entities/message.entity';
import { CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey } from '../auth/entities/api-key.entity';

/**
 * Session-less message lookups. The base {@link MessageController} is scoped to
 * `sessions/:sessionId/messages`, so it cannot host a route that omits the session path param. A
 * single-message-by-id fetch therefore lives here at the top level: `GET /api/messages/:waMessageId`.
 *
 * Read-only and carries no `@RequireRole`, mirroring the other read routes on `MessageController`
 * (`getMessages`, `getChatHistory`, `getReactions`). A valid API key of any role is still required
 * (the global `ApiKeyGuard`); session scoping for keys with `allowedSessions` is applied inside
 * `MessageService.getMessageByWaMessageId`, since the guard has no `:sessionId` to scope against.
 */
@ApiTags('messages')
@Controller('messages')
export class MessageLookupController {
  constructor(private readonly messageService: MessageService) {}

  @Get(':waMessageId')
  @ApiOperation({ summary: 'Get a single message by its WhatsApp message id (no session required)' })
  @ApiParam({
    name: 'waMessageId',
    description: 'WhatsApp message id, e.g. false_120363400287378579@g.us_AC60FA8596471EA47F3EBA73160CEE76_2',
  })
  @ApiResponse({ status: 200, description: 'The message', type: Message })
  @ApiResponse({
    status: 409,
    description:
      'The id is a prefix of more than one stored message (ambiguous). Provide the full waMessageId to disambiguate.',
  })
  @ApiResponse({ status: 404, description: 'Message not found' })
  async getMessage(@Param('waMessageId') waMessageId: string, @CurrentApiKey() apiKey?: ApiKey): Promise<Message> {
    return this.messageService.getMessageByWaMessageId(waMessageId, apiKey?.allowedSessions ?? undefined);
  }
}
