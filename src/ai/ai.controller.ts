import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AiService } from './ai.service';
import { pipeUIMessageStreamToResponse, UIMessage } from 'ai';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /**
   本地测试：
   curl -N -sS -X POST 'http://localhost:3000/ai/chat' \
     -H 'Content-Type: application/json' \
     -d '{"userId":"demo_user_001","sessionId":"session_002","messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"我叫小明，住在杭州"}]}]}'
  */
  @Post('chat')
  async postChat(
    @Body()
    body: { messages?: UIMessage[]; sessionId?: string; userId?: string },
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!body?.messages || !Array.isArray(body.messages)) {
      throw new BadRequestException('Invalid JSON: messages required');
    }

    const sessionId = body.sessionId?.trim() || 'session_002';
    const userId = body.userId?.trim() || 'demo_user_001';
    const stream = await this.aiService.stream(
      sessionId,
      body.messages,
      userId,
    );
    pipeUIMessageStreamToResponse({ response: res, stream });
  }

  /** 查看短期记忆条数与 TTL */
  @Get('memory/:sessionId')
  async getMemory(@Param('sessionId') sessionId: string) {
    return this.aiService.getMemoryMeta(sessionId);
  }

  /** 清空当前会话的 Redis 短期记忆（等价于 CLI 的 :clear） */
  @Delete('memory/:sessionId')
  async clearMemory(@Param('sessionId') sessionId: string) {
    await this.aiService.clearMemory(sessionId);
    return { ok: true, sessionId };
  }

  /** 清空 Mem0 用户层 + 当前会话层（等价于 CLI 的 :clear-mem0） */
  @Delete('memory/:userId/:sessionId/mem0')
  async clearMem0(
    @Param('userId') userId: string,
    @Param('sessionId') sessionId: string,
  ) {
    await this.aiService.clearMem0(userId, sessionId);
    return { ok: true, userId, sessionId };
  }
}
