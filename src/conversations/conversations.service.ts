import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { OpenAIEmbeddings } from '@langchain/openai';
import { User } from './entities/user.entity';
import { Conversation } from './entities/conversation.entity';

@Injectable()
export class ConversationsService {
  private embeddings: OpenAIEmbeddings | null = null;
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) { }

  /** 用户 会话（一对多）*/
  async findCoversationsByUserId(userId: number) {
    const user = await this.em.findOne(User, {
      where: { id: userId },
      relations: { conversations: true },
      order: {
        conversations: {
          createdAt: 'DESC',
        }
      }
    })

    if (!user) {
      throw new NotFoundException(`User #${userId} not found`);
    }

    return user
  }

  async findMessagesByConversationId(conversationId: number) {
    const conversation = await this.em.findOne(Conversation, {
      where: { id: conversationId },
      relations: { messages: true },
      order: {
        messages: {
          createdAt: 'ASC',
        }
      }
    })

    if (!conversation) {
      throw new NotFoundException(`Conversation #${conversationId} not found`);
    }

    return {
      id: conversation.id,
      userId: conversation.userId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      messages: conversation.messages.map(({id, conversationId, role, content, createdAt}) => ({
        id,
        conversationId,
        role,
        content,
        createdAt,
      })),
    }
  }
}
