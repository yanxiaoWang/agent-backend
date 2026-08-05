import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../conversations/entities/user.entity';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import { hashPassword, verifyPassword } from './utils/password.util';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  async register(dto: RegisterDto) {
    const username = dto.userId.trim();
    const exists = await this.usersRepo.exists({ where: { username } });
    if (exists) {
      throw new ConflictException('该用户已存在');
    }

    const user = this.usersRepo.create({
      username,
      name: dto.name?.trim() || username,
      passwordHash: await hashPassword(dto.password),
    });
    const saved = await this.usersRepo.save(user);

    return this.buildAuthResponse(saved);
  }

  async login(dto: LoginDto) {
    const username = dto.userId.trim();
    const user = await this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.username = :username', { username })
      .getOne();

    if (!user?.passwordHash) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    const ok = await verifyPassword(dto.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    return this.buildAuthResponse(user);
  }

  verifyToken(token: string): JwtPayload {
    try {
      return this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token 无效或已过期');
    }
  }

  async getProfile(userId: number) {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('用户不存在或已失效');
    }
    return this.toPublicUser(user);
  }

  private buildAuthResponse(user: User) {
    const payload: JwtPayload = {
      sub: user.id,
      userId: user.username,
      name: user.name,
    };

    return {
      access_token: this.jwtService.sign(payload),
      token_type: 'Bearer',
      user: this.toPublicUser(user),
    };
  }

  private toPublicUser(user: User) {
    return {
      id: user.id,
      userId: user.username,
      name: user.name,
      createdAt: user.createdAt,
    };
  }
}
