import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ProfileService, ProfileLookupResult } from './profile.service';
import { CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey } from '../auth/entities/api-key.entity';

/**
 * Session-less WhatsApp profile lookup for the ERP: `GET /api/profile/:phone`. Session-scoped
 * contact routes can't host it (their `:sessionId` param is what the ApiKeyGuard scopes keys
 * against), so like `MessageLookupController` this lives at the top level; the ready-session
 * choice and the key's `allowedSessions` fence are applied inside {@link ProfileService}.
 *
 * Read-only, no `@RequireRole` — a valid API key of any role passes the global ApiKeyGuard,
 * mirroring the other read lookups.
 */
@ApiTags('profile')
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get(':phone')
  @ApiOperation({
    summary: 'Check a phone number on WhatsApp and fetch its display name + avatar as a data URL (no session required)',
  })
  @ApiParam({
    name: 'phone',
    description: 'International number digits only — no "+" and no "@c.us" (e.g. 380671234567)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Lookup verdict. `exists:false` means the number is not registered on WhatsApp (a normal result, NOT an error); `name`/`profilePic` are null when absent or unfetchable.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid phone (not digits, empty, or outside 8–15 digits); body carries `error: "invalid phone"`.',
  })
  @ApiResponse({
    status: 503,
    description:
      'No READY WhatsApp session (or the lookup hung past its bound); body carries `error: "session not ready"`.',
  })
  async getProfile(@Param('phone') phone: string, @CurrentApiKey() apiKey?: ApiKey): Promise<ProfileLookupResult> {
    return this.profileService.lookupByPhone(phone, apiKey?.allowedSessions ?? undefined);
  }
}
