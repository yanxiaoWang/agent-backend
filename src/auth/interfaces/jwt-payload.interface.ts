export interface JwtPayload {
  /** 数据库用户主键 */
  sub: number;
  /** 业务侧 userId（登录账号） */
  userId: string;
  name: string;
}
