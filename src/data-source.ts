import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { DocumentEntity } from './document/entities/document.entity';
import { User } from './conversations/entities/user.entity';
import { Conversation } from './conversations/entities/conversation.entity';
import { Message } from './conversations/entities/message.entity';

import * as path from 'path';

// 必须写绝对路径！命令行执行，当前工作目录有可能偏移
// config({ path: path.resolve(__dirname, '../.env') });

// console.log("host:", process.env.POSTGRES_HOST);
// console.log("password:", process.env.POSTGRES_PASSWORD);


export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  username: process.env.POSTGRES_USER || 'user',
  password: process.env.POSTGRES_PASSWORD || '123456',
  database: process.env.POSTGRES_DB || 'agent_backend',
  entities: [DocumentEntity, User, Conversation, Message],
  migrations: ['src/migrations/**/*.ts'],
  synchronize: false,
  logging: true
})