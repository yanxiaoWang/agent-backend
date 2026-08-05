import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from '../guards/jwt-auth.guard';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<AuthedRequest>();
    return request.user as JwtPayload;
  },
);
