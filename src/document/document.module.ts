import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DocumentContent,
  DocumentContentSchema,
} from './schemas/document-content.schema';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { FileParserService } from './parser/file-parser.service';
import { DocumentTaskQueue } from './queue/document-task.queue';
import { DocumentTaskWorker } from './queue/document-task.worker';
import { DocumentIndexingService } from './indexing/document-indexing.service';
import { ElasticsearchService } from './indexing/elasticsearch.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentContent.name, schema: DocumentContentSchema },
    ]),
  ],
  controllers: [DocumentController],
  providers: [
    DocumentService,
    FileParserService,
    DocumentTaskQueue,
    DocumentTaskWorker,
    DocumentIndexingService,
    ElasticsearchService,
  ],
  exports: [DocumentService, FileParserService, DocumentIndexingService],
})
export class DocumentModule {}
