import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { SemanticSearchDto } from './dto/semantic-search.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  /** POST /conversations — 创建会话 */
  @Post()
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversationsService.createConversation(user.sub, dto.title);
  }

  /** GET /conversations — 当前用户会话列表 */
  @Get()
  findMine(@CurrentUser() user: JwtPayload) {
    return this.conversationsService.findConversationsByUserId(user.sub);
  }

  /** GET /conversations/:id/messages — 会话的消息列表 */
  @Get(':id/messages')
  findMessages(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.conversationsService.findMessagesByConversationId(
      id,
      user.sub,
    );
  }

  /** POST /conversations/:id/search — 会话内语义检索 */
  @Post(':id/search')
  search(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SemanticSearchDto,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) queryLimit?: number,
  ) {
    const limit = dto.limit ?? queryLimit ?? 5;
    return this.conversationsService.searchSimilarMessages(
      id,
      user.sub,
      dto.query,
      limit,
    );
  }
}
