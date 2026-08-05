import { IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(2)
  userId: string;

  @IsString()
  @MinLength(6)
  password: string;
}

export class RegisterDto {
  /** 登录账号，对应 JWT / AI 链路中的 userId */
  @IsString()
  @MinLength(2)
  userId: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;
}
