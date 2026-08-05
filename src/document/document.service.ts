import {
    Injectable,
    NotFoundException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import { CreateDocumentDto } from './dto/create-document.dto';
//   import { UpdateDocumentDto } from './dto/update-document.dto';
//   import { QueryDocumentDto } from './dto/query-document.dto';
import { UploadParseDto } from './dto/upload-parse.dto';
import {
    DocumentEntity,
    DocumentStatus,
} from './entities/document.entity';
import {
    DocumentContent,
    DocumentContentDocument,
} from './schemas/document-content.schema';
import { RustfsService } from '../storage/rustfs.service';
import { FileParserService } from './parser/file-parser.service';
import {
    decodeUploadFilename,
    getExtension,
    titleFromFilename,
} from './parser/utils/markdown.util';


/**
* 文档服务
* - 元数据：PostgreSQL（kh_document）
* - 正文：MongoDB（document_content）
* - 关联：content_id ↔ Mongo _id，documentId ↔ 文档 id
*/
@Injectable()
export class DocumentService {
    private readonly logger = new Logger(DocumentService.name)
    constructor(
        @InjectEntityManager()
        private readonly em: EntityManager,
        @InjectModel(DocumentContent.name)
        private readonly contentModel: Model<DocumentContentDocument>,

        private readonly fileParserService: FileParserService,
        private readonly rustfs: RustfsService,
    ) { }

     /**
   * 创建文档
   * 流程：生成雪花 ID → 写 Mongo 正文（拿 ObjectId）→ 写 Postgres 元数据
   * 若 Postgres 写入失败，回滚删除已写入的 Mongo 正文，避免脏数据
   */
    async create(dto: CreateDocumentDto) {
        const id = nextSnowflakeId();
        const wordCount = this.countWords(dto.content)
        const status = dto.status ?? DocumentStatus.Draft
        const contentSummary = dto.summary ?? this.buildContentSummary(dto.content)

        // 先写 Mongo，_id 由驱动自动生成 ObjectId
        const contentDoc = await this.contentModel.create({
            documentId: id,
            content: dto.content,
            contentLength: dto.content.length,
            contentSummary,
            version: 1,
            deleted: false,
        })

         // ObjectId 转字符串，存入 Postgres content_id
        const contentId = String(contentDoc._id)
        try {
            const doc = this.em.create(DocumentEntity, {
                id,
                title: dto.title,
                contentId,
                summary: dto.summary,
                categoryId: dto.categoryId,
                teamId: dto.teamId,
                authorId: dto.authorId,
                coverImage: dto.coverImage,
                tags: dto.tags,
                status,
                remark: dto.remark,
                isPublic: dto.isPublic ?? false,
                wordCount,
                // 创建即发布时，记录发布时间
                publishTime: status === DocumentStatus.Published ? new Date() : null,
                createBy: dto.createBy,
                updateBy: dto.createBy,
                deleted: false,
            })
            const saved = await this.em.save(doc)
            return { ...saved, content: dto.content }
        } catch (error) {
            // Postgres 失败：物理删除刚写入的 Mongo 正文
            await this.contentModel.deleteOne({ _id: contentId })
            throw error
        }
    }

    /** 上传并解析文件 → 创建草稿文档 */
    async uploadAndCreateDocument(file: Express.Multer.File, meta: UploadParseDto = {}) {
        if (!file?.buffer?.length) {
            throw new BadRequestException('文件不能为空')
        }
        const originalFilename = decodeUploadFilename(file.originalname);
        const extension = getExtension(originalFilename);

        if (!this.fileParserService.isSupported(extension)) {
            throw new BadRequestException(
                `不支持的文件格式: ${extension}，支持的格式: ${this.fileParserService.supportedList()}`,
            );
        }

        this.logger.log(
            `上传并解析文件：name=${originalFilename}, size=${file.size}, ext=${extension}`,
        );

        let parsedContent: string;
        try {
            parsedContent = await this.fileParserService.parse({
                originalname: originalFilename,
                buffer: file.buffer,
                size: file.size,
            });
        } catch (error) {
            if (error instanceof BadRequestException) throw error;
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`文件解析失败：name=${originalFilename}, error=${message}`);
            throw new BadRequestException(`文件解析失败: ${message}`);
        }

        let fileUrl: string | null = null;
        if (this.rustfs.isEnabled()) {
            try {
                fileUrl = await this.rustfs.uploadBytes(file.buffer, {
                    fileName: originalFilename,
                    contentType: file.mimetype || 'application/octet-stream',
                    prefix: 'documents',
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`原文件上传 RustFS 失败：${message}`);
                throw new BadRequestException(`原文件上传失败: ${message}`);
            }
        } else {
            this.logger.warn('RustFS 未启用，跳过原文件上传');
        }

        const title = titleFromFilename(originalFilename);

        const created = await this.create({
            title,
            content: parsedContent,
            categoryId: meta.categoryId,
            teamId: meta.teamId,
            authorId: meta.authorId,
            tags: meta.tags,
            remark: meta.remark,
            createBy: meta.createBy,
            isPublic: meta.isPublic,
            status: DocumentStatus.Draft,
        });

        const previewLen = Math.min(200, parsedContent.length);
        const result = {
            documentId: created.id,
            title,
            fileUrl,
            fileSize: file.size,
            fileExtension: extension,
            contentLength: parsedContent.length,
            contentPreview: parsedContent.slice(0, previewLen),
            status: DocumentStatus.Draft,
        };

        this.logger.log(
            `文件解析并创建文档成功：documentId=${created.id}, title=${title}, ext=${extension}, chars=${parsedContent.length}, fileUrl=${fileUrl}`,
        );

        return result;
    }

    /**
   * 从正文截取预览摘要
   * 压缩连续空白后截断到 maxLen，超出则追加省略号
   */
    private buildContentSummary(content: string, maxLen = 200): string {
        const trimmed = content.trim().replace(/\s+/g, ' ');
        return trimmed.length <= maxLen
            ? trimmed
            : `${trimmed.slice(0, maxLen)}...`;
    }

    /**
   * 统计正文字数（中英混合）
   * - 中日韩汉字：每个字符计 1 字
   * - 英文等拉丁文本：按空白分词，每个单词计 1 字
   */
    private countWords(content: string): number {
        const trimmed = content.trim();
        if (!trimmed) return 0;

        // 匹配所有 CJK 统一汉字（U+4E00–U+9FFF），每个汉字算 1
        const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;

        // 去掉汉字后，剩余按空白切分为英文单词再计数
        const latin = trimmed
            .replace(/[\u4e00-\u9fff]/g, ' ') // 汉字替换为空格，避免与英文粘连
            .trim()
            .split(/\s+/) // 按连续空白分词
            .filter(Boolean).length; // 去掉空串

        return cjk + latin;
    }

}
