import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, OneToMany} from 'typeorm'
import { Conversation } from './conversation.entity'

@Entity('users')
export class User {
    @PrimaryGeneratedColumn()
    id:number;

    @Column({type: 'text'})
    name: string;

    @CreateDateColumn({type: 'timestamptz', name: 'create_at'})
    createdAt: Date;
    
    @OneToMany(() => Conversation, conversation => conversation.user)
    conversations: Conversation[];

}