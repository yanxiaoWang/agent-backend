import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  /** 登录账号（唯一） */
  @Column({ type: 'text', unique: true })
  username: string;

  @Column({ type: 'text' })
  name: string;

  /** salt:hash，不对外返回 */
  @Column({ type: 'text', name: 'password_hash', select: false })
  passwordHash: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'create_at' })
  createdAt: Date;

  @OneToMany(() => Conversation, (conversation) => conversation.user)
  conversations: Conversation[];
}
