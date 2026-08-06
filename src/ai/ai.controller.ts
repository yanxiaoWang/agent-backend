import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AiService } from './ai.service';
import { pipeUIMessageStreamToResponse, UIMessage } from 'ai';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /**
   本地测试：
   1) 登录拿 token
   2) POST /conversations → { id }
   3) curl -N -sS -X POST 'http://localhost:3000/ai/chat' \
        -H 'Authorization: Bearer <token>' \
        -H 'Content-Type: application/json' \
        -d '{"conversationId":1,"messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"我叫小明，住在杭州"}]}]}'
  */
  @Post('chat')
  @UseGuards(JwtAuthGuard)
  async postChat(
    @CurrentUser() user: JwtPayload,
    @Body()
    body: { messages?: UIMessage[]; conversationId?: number },
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!body?.messages || !Array.isArray(body.messages)) {
      throw new BadRequestException('Invalid JSON: messages required');
    }
    if (
      body.conversationId == null ||
      !Number.isFinite(Number(body.conversationId))
    ) {
      throw new BadRequestException('conversationId required');
    }

    const conversationId = Number(body.conversationId);
    const stream = await this.aiService.stream(
      conversationId,
      body.messages,
      user.sub,
      user.userId,
    );
    pipeUIMessageStreamToResponse({ response: res, stream });
  }

  /** 查看短期记忆条数与 TTL（sessionId = conversationId 字符串） */
  @Get('memory/:sessionId')
  async getMemory(@Param('sessionId') sessionId: string) {
    return this.aiService.getMemoryMeta(sessionId);
  }

  /** 清空当前会话的 Redis 短期记忆 */
  @Delete('memory/:sessionId')
  async clearMemory(@Param('sessionId') sessionId: string) {
    await this.aiService.clearMemory(sessionId);
    return { ok: true, sessionId };
  }

  /** 清空 Mem0 用户层 + 当前会话层 */
  @Delete('memory/:userId/:sessionId/mem0')
  async clearMem0(
    @Param('userId') userId: string,
    @Param('sessionId') sessionId: string,
  ) {
    await this.aiService.clearMem0(userId, sessionId);
    return { ok: true, userId, sessionId };
  }
}
