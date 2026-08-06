import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import { OpenAIEmbeddings } from '@langchain/openai';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { User } from './entities/user.entity';
import { Conversation } from './entities/conversation.entity';
import { Message, MessageRole } from './entities/message.entity';

export interface SemanticSearchResult {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  created_at: Date;
  similarity: number;
}

export interface AppendTurnResult {
  userMessage: Message;
  assistantMessage: Message;
}

/** Redis 冷启动时从 PG 回填的最大条数 */
const REDIS_BACKFILL_LIMIT = 40;

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);
  private embeddings: OpenAIEmbeddings | null = null;

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  async createConversation(userId: number, title?: string) {
    const user = await this.em.findOne(User, { where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User #${userId} not found`);
    }

    const conversation = this.em.create(Conversation, {
      userId,
      title: title?.trim() || null,
    });
    await this.em.save(conversation);

    return {
      id: conversation.id,
      userId: conversation.userId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  /** 校验会话归属，返回会话实体 */
  async ensureOwned(conversationId: number, userId: number): Promise<Conversation> {
    const conversation = await this.em.findOne(Conversation, {
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation #${conversationId} not found`);
    }
    if (conversation.userId !== userId) {
      throw new ForbiddenException('无权访问该会话');
    }
    return conversation;
  }

  /** 当前用户的会话列表（按最近活跃） */
  async findConversationsByUserId(userId: number) {
    const user = await this.em.findOne(User, { where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User #${userId} not found`);
    }

    const conversations = await this.em.find(Conversation, {
      where: { userId },
      order: { updatedAt: 'DESC' },
    });

    return conversations.map((c) => ({
      id: c.id,
      userId: c.userId,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  async findMessagesByConversationId(conversationId: number, userId: number) {
    await this.ensureOwned(conversationId, userId);

    const conversation = await this.em.findOne(Conversation, {
      where: { id: conversationId },
      relations: { messages: true },
      order: {
        messages: {
          createdAt: 'ASC',
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation #${conversationId} not found`);
    }

    return {
      id: conversation.id,
      userId: conversation.userId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: conversation.messages.map(
        ({ id, conversationId: cid, role, content, createdAt }) => ({
          id,
          conversationId: cid,
          role,
          content,
          createdAt,
        }),
      ),
    };
  }

  /**
   * 追加一轮对话（user + assistant），并刷新会话 updated_at / 首轮 title。
   * embedding 异步补写，不阻塞主路径。
   */
  async appendTurn(
    conversationId: number,
    userId: number,
    userContent: string,
    assistantContent: string,
  ): Promise<AppendTurnResult> {
    const conversation = await this.ensureOwned(conversationId, userId);
    const userText = userContent.trim();
    const assistantText = assistantContent.trim();

    if (!userText || !assistantText) {
      throw new BadRequestException('user/assistant 消息内容不能为空');
    }

    return this.em.transaction(async (tx) => {
      const userMessage = tx.create(Message, {
        conversationId,
        role: MessageRole.USER,
        content: userText,
        embedding: null,
      });
      const assistantMessage = tx.create(Message, {
        conversationId,
        role: MessageRole.ASSISTANT,
        content: assistantText,
        embedding: null,
      });

      await tx.save([userMessage, assistantMessage]);

      if (!conversation.title) {
        conversation.title = this.makeTitle(userText);
      }
      conversation.updatedAt = new Date();
      await tx.save(conversation);

      return { userMessage, assistantMessage };
    });
  }

  /** 为消息补写 embedding（可失败，不影响主流程） */
  async embedMessageIds(messageIds: number[]): Promise<void> {
    if (!messageIds.length) return;

    const messages = await this.em.find(Message, {
      where: { id: In(messageIds) },
    });
    const pending = messages.filter((m) => m.content?.trim() && !m.embedding);
    if (!pending.length) return;

    const vectors = await this.getEmbeddings().embedDocuments(
      pending.map((m) => m.content),
    );

    for (let i = 0; i < pending.length; i++) {
      await this.em.query(
        `UPDATE messages SET embedding = $1::vector WHERE id = $2`,
        [JSON.stringify(vectors[i]), pending[i].id],
      );
    }
  }

  /**
   * Redis miss 时从 PG 拉取最近消息，转为 LangChain BaseMessage。
   */
  async loadRecentBaseMessages(
    conversationId: number,
    limit = REDIS_BACKFILL_LIMIT,
  ): Promise<BaseMessage[]> {
    const rows = await this.em.find(Message, {
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return rows
      .reverse()
      .map((m) => this.toBaseMessage(m.role, m.content))
      .filter((m): m is BaseMessage => m != null);
  }

  /** 会话内语义检索（pgvector 余弦距离） */
  async searchSimilarMessages(
    conversationId: number,
    userId: number,
    searchText: string,
    limit = 5,
  ): Promise<SemanticSearchResult[]> {
    await this.ensureOwned(conversationId, userId);

    const vector = await this.embedQuery(searchText);

    const rows: SemanticSearchResult[] = await this.em.query(
      `SELECT id, conversation_id, role, content, created_at,
              1 - (embedding <=> $1::vector) AS similarity
       FROM messages
       WHERE conversation_id = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [JSON.stringify(vector), conversationId, limit],
    );

    return rows.map((row) => ({
      ...row,
      similarity: Number(row.similarity),
    }));
  }

  private makeTitle(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length <= 40 ? compact : `${compact.slice(0, 40)}…`;
  }

  private toBaseMessage(role: MessageRole | string, content: string): BaseMessage | null {
    switch (role) {
      case MessageRole.USER:
      case 'user':
        return new HumanMessage(content);
      case MessageRole.ASSISTANT:
      case 'assistant':
        return new AIMessage(content);
      case MessageRole.SYSTEM:
      case 'system':
        return new SystemMessage(content);
      default:
        this.logger.warn(`Unknown message role: ${role}`);
        return null;
    }
  }

  private getEmbeddings(): OpenAIEmbeddings {
    if (!this.embeddings) {
      if (!process.env.OPENAI_API_KEY) {
        throw new BadRequestException(
          '语义检索需要配置 OPENAI_API_KEY（与 pgsql-test 相同）',
        );
      }
      this.embeddings = new OpenAIEmbeddings({
        model: process.env.EMBEDDING_MODEL || 'text-embedding-v3',
        apiKey: process.env.OPENAI_API_KEY,
        configuration: {
          baseURL: process.env.OPENAI_BASE_URL,
        },
      });
    }
    return this.embeddings;
  }

  private async embedQuery(text: string): Promise<number[]> {
    return this.getEmbeddings().embedQuery(text);
  }
}
