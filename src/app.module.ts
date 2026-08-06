import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DocumentModule } from './document/document.module';
import { DocumentEntity } from './document/entities/document.entity';
import { DocumentTaskEntity } from './document/entities/document-task.entity';
import { DocumentChunkEntity } from './document/entities/document-chunk.entity';
import { StorageModule } from './storage/storage.module';
import { AiModule } from './ai/ai.module';
import { MemoryModule } from './memory/memory.module';
import { ConversationsModule } from './conversations/conversations.module';
import { User } from './conversations/entities/user.entity';
import { Conversation } from './conversations/entities/conversation.entity';
import { Message } from './conversations/entities/message.entity';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [ConfigModule.forRoot({
    isGlobal: true,
    envFilePath: '.env',
  }), MemoryModule, AiModule, StorageModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('POSTGRES_HOST', 'localhost'),
        port: config.get<number>('POSTGRES_PORT', 5432),
        username: config.get<string>('POSTGRES_USER', 'user'),
        password: config.get<string>('POSTGRES_PASSWORD', '123456'),
        database: config.get<string>('POSTGRES_DB', 'agent_backend'),
        entities: [
          DocumentEntity,
          DocumentTaskEntity,
          DocumentChunkEntity,
          User,
          Conversation,
          Message,
        ],
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
        synchronize: false, // 多人本地开发务必false！不要开true
      }),
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>(
          'MONGO_URI',
          'mongodb://mongo_user:mongo_pass123@localhost:27017/knowledge_hub?authSource=admin',
        ),
      }),
    }), DocumentModule, ConversationsModule, AuthModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
