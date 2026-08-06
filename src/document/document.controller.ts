import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { DocumentService } from './document.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UploadParseDto } from './dto/upload-parse.dto';

@Controller('document')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Post()
  create(@Body() createDocumentDto: CreateDocumentDto) {
    return this.documentService.create(createDocumentDto);
  }

  /**
   * 上传文件并异步解析入库（P1）。
   * form-data 字段名: file；立即返回 taskId，前端轮询 GET /document/task/:taskId
   */
  @Post('upload/parse')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  uploadAndParse(
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: UploadParseDto,
  ) {
    if (!file) {
      throw new BadRequestException('请上传文件（form-data 字段名: file）');
    }
    return this.documentService.enqueueUpload(file, meta);
  }

  /** 查询异步任务进度 */
  @Get('task/:taskId')
  getTask(@Param('taskId') taskId: string) {
    return this.documentService.getTask(taskId);
  }

  /** 知识库语义检索（P2 pgvector） */
  @Get('search')
  search(
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Number(limit) : 8;
    return this.documentService.search(q, Number.isFinite(n) ? n : 8);
  }
}
