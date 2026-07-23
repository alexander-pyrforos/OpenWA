import { Controller, Get, Post, Delete, Param, Query, Body, HttpCode, HttpStatus, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { SessionService } from './session.service';
import { BackfillJobState } from './backfill-job-state';
import {
  CreateSessionDto,
  SessionResponseDto,
  QRCodeResponseDto,
  MarkChatReadDto,
  DeleteChatDto,
  SendChatStateDto,
  RequestPairingCodeDto,
  PairingCodeResponseDto,
} from './dto';
import { Session } from './entities/session.entity';
import { ChatSummary } from '../../engine/interfaces/whatsapp-engine.interface';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { RequireRole, CurrentApiKey, SessionScoped } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('sessions')
@Controller('sessions')
// The `:id` route param here is a WhatsApp session id, so the ApiKeyGuard enforces a key's
// allowedSessions scope against it (other controllers' `:id` is an unrelated resource id).
@SessionScoped()
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly auditService: AuditService,
  ) {}

  private transformSession(session: Session): SessionResponseDto {
    return SessionResponseDto.fromEntity(session);
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a new WhatsApp session' })
  @ApiResponse({
    status: 201,
    description: 'Session created',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 409, description: 'Session name already exists' })
  async create(@Body() dto: CreateSessionDto): Promise<Session> {
    const session = await this.sessionService.create(dto);
    await this.auditService.logInfo(AuditAction.SESSION_CREATED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return session;
  }

  @Get()
  @ApiOperation({ summary: 'List all sessions' })
  @ApiResponse({
    status: 200,
    description: 'List of sessions',
    type: [SessionResponseDto],
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Max sessions to return (1-1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of sessions to skip (for paging)' })
  async findAll(
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<SessionResponseDto[]> {
    // Scope to the key's allowedSessions so a session-restricted key cannot enumerate every
    // session. A null/empty allowlist (e.g. ADMIN) still lists all.
    const sessions = await this.sessionService.findAll(apiKey?.allowedSessions, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return sessions.map(s => this.transformSession(s));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get session by ID' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session details',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.findOne(id);
    return this.transformSession(session);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 204, description: 'Session deleted' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const session = await this.sessionService.findOne(id);
    await this.sessionService.delete(id);
    await this.auditService.logInfo(AuditAction.SESSION_DELETED, {
      sessionId: id,
      sessionName: session.name,
    });
  }

  @Post(':id/start')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Start a session and initialize WhatsApp connection',
  })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session started',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Session already started' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async start(@Param('id', ParseUUIDPipe) id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.start(id);
    await this.auditService.logInfo(AuditAction.SESSION_STARTED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Post(':id/stop')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Stop a session and disconnect WhatsApp' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session stopped',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async stop(@Param('id', ParseUUIDPipe) id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.stop(id);
    await this.auditService.logInfo(AuditAction.SESSION_STOPPED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Post(':id/force-kill')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Force-kill a stuck session (SIGKILL its wedged engine, then tear it down)' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Session force-killed',
    type: SessionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async forceKill(@Param('id', ParseUUIDPipe) id: string): Promise<SessionResponseDto> {
    const session = await this.sessionService.forceKill(id);
    await this.auditService.logInfo(AuditAction.SESSION_FORCE_KILLED, {
      sessionId: session.id,
      sessionName: session.name,
    });
    return this.transformSession(session);
  }

  @Post(':id/backfill-history')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Backfill chat history with author metadata (in-process, fire-and-forget)',
  })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiQuery({ name: 'batchSize', required: false, type: Number, description: 'Messages per chat (default 50, max 1000)' })
  @ApiQuery({ name: 'rateMs', required: false, type: Number, description: 'Throttle between chats in ms (default 1500)' })
  @ApiQuery({ name: 'includeMedia', required: false, type: Boolean, description: 'Fetch media too (default false)' })
  @ApiQuery({ name: 'chatId', required: false, description: 'Restrict to these chat ids (repeatable: ?chatId=a&chatId=b)' })
  @ApiResponse({ status: 202, description: 'Backfill started', type: Object })
  @ApiResponse({ status: 409, description: 'A backfill is already running for this session' })
  @ApiResponse({ status: 400, description: 'Session has no live engine — start the session first' })
  @HttpCode(HttpStatus.ACCEPTED)
  async startBackfill(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('batchSize') batchSize?: string,
    @Query('rateMs') rateMs?: string,
    @Query('includeMedia') includeMedia?: string,
    @Query('chatId') chatId?: string | string[],
  ): Promise<{ started: true; sessionId: string; state: BackfillJobState }> {
    const chatIds = Array.isArray(chatId) ? chatId : chatId ? [chatId] : [];
    const state = await this.sessionService.startHistoryBackfill(id, {
      batchSize: batchSize ? parseInt(batchSize, 10) : undefined,
      rateMs: rateMs ? parseInt(rateMs, 10) : undefined,
      includeMedia: includeMedia === 'true' ? true : includeMedia === 'false' ? false : undefined,
      chatIds,
    });
    await this.auditService.logInfo(AuditAction.SESSION_HISTORY_BACKFILL, {
      sessionId: id,
    });
    return { started: true, sessionId: id, state };
  }

  @Get(':id/backfill-history')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'History backfill job status for a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Current backfill job state, or null if none has run' })
  async getBackfillStatus(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ state: BackfillJobState | null }> {
    return { state: this.sessionService.getBackfillJob(id) ?? null };
  }

  @Get(':id/qr')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Get QR code for session authentication' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'QR code data',
    type: QRCodeResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'QR code not ready or session already authenticated',
  })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getQRCode(@Param('id', ParseUUIDPipe) id: string): Promise<QRCodeResponseDto> {
    const qrCode = await this.sessionService.getQRCode(id);
    await this.auditService.logInfo(AuditAction.SESSION_QR_GENERATED, {
      sessionId: id,
    });
    return qrCode;
  }

  @Post(':id/pairing-code')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Request an 8-char pairing code to link via phone number (alternative to QR)' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Pairing code generated', type: PairingCodeResponseDto })
  @ApiResponse({ status: 400, description: 'Session not started or already authenticated' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async requestPairingCode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestPairingCodeDto,
  ): Promise<PairingCodeResponseDto> {
    return this.sessionService.requestPairingCode(id, dto.phoneNumber);
  }

  @Get(':id/groups')
  @ApiOperation({ summary: 'Get all groups for a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'List of groups the session is a member of',
  })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max groups to return (1–1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of groups to skip (for paging)' })
  async getGroups(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ id: string; name: string; linkedParentJID?: string | null }[]> {
    return this.sessionService.getGroups(id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get(':id/chats')
  @ApiOperation({ summary: 'Get active chats for a session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'List of active chats (most recent first)' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max chats to return (1–1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of chats to skip (for paging)' })
  async getChats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ChatSummary[]> {
    return this.sessionService.getChats(id, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Post(':id/chats/read')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Mark a chat as read/seen' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chat marked as read successfully' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async markChatRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkChatReadDto,
  ): Promise<{ success: boolean }> {
    const success = await this.sessionService.sendSeen(id, dto.chatId);
    return { success };
  }

  @Post(':id/chats/unread')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Mark a chat as unread' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chat marked as unread successfully' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async markChatUnread(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkChatReadDto,
  ): Promise<{ success: boolean }> {
    const success = await this.sessionService.markUnread(id, dto.chatId);
    return { success };
  }

  @Post(':id/chats/delete')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete a chat from the chat list (e.g. a group you have left)' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Chat deleted successfully' })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async deleteChat(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeleteChatDto): Promise<{ success: boolean }> {
    const success = await this.sessionService.deleteChat(id, dto.chatId);
    return { success };
  }

  @Post(':id/chats/typing')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: "Send a typing/recording presence indicator to a chat (or clear it with 'paused')" })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Presence sent' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async sendChatState(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendChatStateDto,
  ): Promise<{ success: boolean }> {
    await this.sessionService.sendChatState(id, dto.chatId, dto.state);
    return { success: true };
  }

  @Get('stats/overview')
  @ApiOperation({
    summary: 'Get session statistics for multi-session monitoring',
  })
  @ApiResponse({
    status: 200,
    description: 'Session statistics including counts and memory usage',
  })
  async getStats(@CurrentApiKey() apiKey?: ApiKey): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    // Scope aggregate stats to the key's allowedSessions so a session-restricted key cannot enumerate
    // global session counts/status (the route carries no :id for the guard to scope against).
    return this.sessionService.getStats(apiKey?.allowedSessions);
  }
}
